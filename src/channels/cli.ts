import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { formatToolLine } from '../cli/format-tool-line.js';
import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, DeliveryAddress, InboundEvent } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

type Frame = Record<string, unknown>;
let output: ((frame: Frame) => void) | undefined;
export function notifyCliTurnComplete(): void {
  output?.({ type: 'done' });
}
export function notifyCliStatus(lines: string[]): void {
  output?.({ type: 'status', lines });
}

function address(value: unknown): DeliveryAddress | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Frame;
  if (typeof record.channelType !== 'string' || typeof record.platformId !== 'string') return undefined;
  return {
    channelType: record.channelType,
    platformId: record.platformId,
    threadId: typeof record.threadId === 'string' ? record.threadId : null,
  };
}
function write(socket: net.Socket, frame: Frame): void {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(frame) + '\n');
}

/** The protected host socket is an operator transport, with one active conversation. */
function localChannel(): ChannelAdapter {
  const filename = path.join(DATA_DIR, 'cli.sock');
  const peers = new Set<net.Socket>();
  let listener: net.Server | undefined;
  let conversation: net.Socket | undefined;

  async function receive(frame: Frame, socket: net.Socket, host: ChannelSetup): Promise<void> {
    if (typeof frame.text !== 'string' || !frame.text) return;
    const target = address(frame.to);
    const redirect = address(frame.reply_to);
    if (!target && conversation !== socket) {
      if (conversation) {
        write(conversation, { text: '[superseded by a newer client]' });
        conversation.end();
      }
      conversation = socket;
      output = (value) => {
        if (conversation === socket) write(socket, value);
      };
    }
    const message = {
      id: `cli-${randomUUID()}`,
      kind: 'chat' as const,
      timestamp: new Date().toISOString(),
      content: {
        text: frame.text,
        sender: target && typeof frame.sender === 'string' ? frame.sender : 'cli',
        senderId: target && typeof frame.senderId === 'string' ? frame.senderId : 'cli:local',
      },
    };
    if (!target && frame.ephemeral !== true) {
      await host.onInbound('local', null, message);
      return;
    }
    const event: InboundEvent = {
      channelType: target?.channelType ?? 'cli',
      platformId: target?.platformId ?? 'local',
      threadId: target?.threadId ?? null,
      message: { ...message, content: JSON.stringify(message.content) },
      ...(target ? { replyTo: redirect } : { ephemeral: true }),
    };
    await host.onInboundEvent(event);
  }

  return {
    name: 'cli',
    channelType: 'cli',
    supportsThreads: false,
    async setup(host) {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      try {
        fs.unlinkSync(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      listener = net.createServer((socket) => {
        peers.add(socket);
        socket.setEncoding('utf8');
        let pending = '';
        socket.on('data', (chunk: string) => {
          pending += chunk;
          if (pending.length > 8 * 1024 * 1024) {
            socket.destroy();
            return;
          }
          const lines = pending.split('\n');
          pending = lines.pop()!;
          for (const line of lines) {
            let decoded: unknown;
            try {
              decoded = JSON.parse(line);
            } catch {
              continue;
            }
            if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
              void receive(decoded as Frame, socket, host).catch((error) =>
                log.error('Local message routing failed', { error }),
              );
            }
          }
        });
        socket.once('close', () => {
          peers.delete(socket);
          if (conversation === socket) {
            conversation = undefined;
            output = undefined;
          }
        });
        socket.on('error', (error) => log.warn('Local conversation disconnected', { error }));
      });
      const server = listener;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(filename, () => {
          try {
            fs.chmodSync(filename, 0o600);
            resolve();
          } catch (error) {
            server.close();
            reject(error);
          }
        });
      });
    },
    async teardown() {
      output = undefined;
      conversation = undefined;
      for (const socket of peers) socket.destroy();
      peers.clear();
      if (listener) {
        const server = listener;
        listener = undefined;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(filename, { force: true });
    },
    isConnected: () => listener?.listening ?? false,
    async deliver(platform, _thread, message): Promise<string | undefined> {
      if (platform !== 'local' || !conversation) return;
      const content = message.content;
      if (message.kind === 'cli-tool' && content && typeof content === 'object') {
        const frame = content as Frame;
        if (typeof frame.name === 'string')
          write(conversation, {
            type: 'tool',
            line: formatToolLine(
              frame.name,
              frame.args && typeof frame.args === 'object' && !Array.isArray(frame.args) ? (frame.args as Frame) : {},
            ),
          });
        return;
      }
      const text =
        typeof content === 'string'
          ? content
          : content && typeof content === 'object'
            ? (content as Frame).text
            : undefined;
      if (typeof text === 'string') write(conversation, { text });
    },
  };
}
registerChannelAdapter('cli', { factory: localChannel });
