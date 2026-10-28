import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { getCurrentInReplyTo, getCurrentTaskRun } from '../current-batch.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { MEMORY_URI_PREFIX, memoryRoot } from '../providers/openai/tools/memory-files.js';
import { getSessionClient } from '../session/client.js';
import { PROCESS_UPDATE_MARKER } from '../reply-contract.js';
import { writeStatusMessage } from '../status-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const log = (message: string): void => console.error(`[mcp-tools] ${message}`);
const generateId = (): string => `msg-${randomUUID()}`;
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ ...ok(`Error: ${text}`), isError: true });
type ResolvedRouting = { resolvedName: string; platform_id: string; channel_type: string; thread_id: string | null };

async function resolveRouting(requested: string | undefined): Promise<ResolvedRouting | { error: string }> {
  const current = await getSessionRouting();
  let name = requested?.trim();
  if (!name && current.channel_type && current.platform_id) return {
    resolvedName: '(current conversation)', platform_id: current.platform_id,
    channel_type: current.channel_type, thread_id: current.thread_id,
  };
  if (!name) {
    const choices = await getAllDestinations();
    if (!choices.length) return { error: 'No destinations configured.' };
    if (choices.length !== 1) return { error: `Choose a destination with to. Options: ${choices.map((choice) => choice.name).join(', ')}` };
    name = choices[0]!.name;
  }
  const target = await findByName(name);
  if (!target) return { error: `Unknown destination "${name}". Known: ${(await getAllDestinations()).map((choice) => choice.name).join(', ') || '(none)'}` };
  if (target.type === 'agent') return { resolvedName: name, channel_type: 'agent', platform_id: target.agentGroupId!, thread_id: null };
  return {
    resolvedName: name, platform_id: target.platformId!, channel_type: target.channelType!,
    thread_id: target.platformId === current.platform_id && target.channelType === current.channel_type ? current.thread_id : null,
  };
}

async function enqueueChat(destination: ResolvedRouting, payload: Record<string, unknown>, id = generateId(), reply = true): Promise<{ id: string; seq: number }> {
  const message = {
    id, kind: 'chat', content: JSON.stringify(payload),
    channel_type: destination.channel_type, thread_id: destination.thread_id, platform_id: destination.platform_id,
    ...(reply ? { in_reply_to: getCurrentInReplyTo() } : {}),
  };
  return { id, seq: await writeMessageOut(message) };
}

/**
 * Resolve `send_file`'s two mutually exclusive sources.
 *
 * `path` used to accept any absolute path unconditionally, which let a model
 * reach into memory and get a silent success that bypassed every size,
 * policy, and journal check. Memory files now go through `memory`, and a
 * memory-rooted `path` is refused with the right move rather than honored.
 */
function resolveSendSource(args: Record<string, unknown>): { abs: string } | { memory: string } | { error: string } {
  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  const memory = typeof args.memory === 'string' ? args.memory.trim() : '';

  if (memory && filePath) return { error: 'pass either `memory` (knowledge base) or `path` (workspace), not both' };
  if (!memory && !filePath) return { error: '`path` or `memory` is required' };

  if (memory) {
    return { memory };
  }

  if (filePath.toLowerCase().startsWith(MEMORY_URI_PREFIX)) {
    return { error: `"${filePath}" is a knowledge-base id — pass it as \`memory\`, not \`path\`` };
  }

  const abs = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
  const root = memoryRoot();
  if (root && (abs === root || abs.startsWith(`${root}${path.sep}`))) {
    return { error: 'that path is inside the knowledge base — use `memory: "memory:<folder>/<name.ext>"` instead' };
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { error: `File not found: ${filePath}` };
  return { abs };
}

async function isCurrentConversationRouting(routing: ResolvedRouting): Promise<boolean> {
  const session = await getSessionRouting();
  return (
    routing.channel_type === session.channel_type &&
    routing.platform_id === session.platform_id &&
    routing.thread_id === session.thread_id
  );
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description:
      'Send a durable message to a named destination. Omit `to` only for a temporary progress update in the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Use a name from the session destination list.',
        },
        text: { type: 'string', description: 'Text to deliver' },
        source_email_ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description:
            'Required for a named scheduled report (use [] without email findings): message IDs from read_thread/read_message supporting the reported personal findings. ' +
            'The host privately attaches original source text and dates for memory. Use a named to; omit routine ads/newsletters.',
        },
        source_email_findings: {
          type: 'array', maxItems: 40,
          items: { type: 'object', properties: {
            text: { type: 'string', maxLength: 3000, description: 'Literal substring of the text argument describing one personal finding. Copy Markdown markers too: "Payment **EUR 25** is pending." must keep the ** markers. Do not paraphrase the rendered text.' },
            source_email_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
          }, required: ['text', 'source_email_ids'] },
          description: 'For email digests, link each personal finding to all original message IDs it depends on, including disagreement and thread context. These links stay private and allow complete evidence batching.',
        },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (typeof text !== 'string' || !text.trim()) return err('text is required');
    const sourceIds = args.source_email_ids;
    const findings = args.source_email_findings;
    if (getCurrentTaskRun() && args.to && sourceIds === undefined) {
      return err('Scheduled reports require an explicit source_email_ids array. If the report has no personal email findings, use source_email_ids: [] and source_email_findings: []. Do not add routine newsletters or invent findings to repair this missing field. Read original bodies for actual findings; these IDs stay private.');
    }
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.length > 20 ||
      sourceIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9._-]+:[0-9a-fA-F]{1,16}$/.test(id)))) {
      return err('source_email_ids must contain at most 20 message IDs from read_thread/read_message');
    }
    if (findings !== undefined && (!Array.isArray(findings) || findings.length > 40 || findings.some(f =>
      !f || typeof f.text !== 'string' || !f.text.trim() || f.text.length > 3000 ||
      !Array.isArray(f.source_email_ids) || !f.source_email_ids.length || f.source_email_ids.length > 20 ||
      f.source_email_ids.some((id: unknown) => !Array.isArray(sourceIds) || !sourceIds.includes(id))))) {
      return err('source_email_findings must link exact report excerpts to selected source_email_ids');
    }
    if (Array.isArray(findings)) {
      // Match the host's visible-text boundary. A rendered excerpt may look identical
      // while omitting Markdown present in the actual report bytes.
      const visible = text.replace(/<internal>[\s\S]*?<\/internal>/gi, '').replace(/<\/?message[^>]*>/gi, '');
      const mismatches = findings.flatMap((finding, index) => visible.includes(finding.text) ? [] : [`source_email_findings[${index}].text`]);
      if (mismatches.length) {
        return err(`${mismatches.join(', ')} must be exact substrings of the text argument's visible report. ` +
          'Copy the excerpts literally, including Markdown markers such as ** and *. Do not paraphrase or remove formatting, and do not quote <internal> text. ' +
          'Correct these findings and retry send_message; no message has been queued.');
      }
    }
    if (Array.isArray(findings) && Array.isArray(sourceIds) && sourceIds.some(id => !findings.some(f => f.source_email_ids.includes(id)))) {
      return err('source_email_ids must be exactly the union of IDs supporting source_email_findings. Remove sources used only for newsletters, coverage notes or empty checks.');
    }

    // Naming a destination is an explicit delivery request, even when that
    // destination happens to be the conversation this task is running in.
    // Daily briefings exposed why routing equality cannot decide intent: the
    // model generated the whole briefing in `send_message({to, text})`, Luna
    // rendered it only inside the progress bubble, then collapsed the bubble
    // and delivered the model's final "sent" acknowledgement by itself.
    //
    // An omitted `to` remains the concise mid-turn-update shorthand taught by
    // core.instructions.md. That is the only form allowed to be ephemeral.
    const namedDestination = typeof args.to === 'string' && args.to.trim().length > 0;

    const routing = await resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    if (!namedDestination && (await isCurrentConversationRouting(routing))) {
      if (Array.isArray(sourceIds) && sourceIds.length > 0) {
        return err('A report with source_email_ids needs a named `to` so its evidence accompanies a durable message.');
      }
      await writeStatusMessage({
        channel_type: routing.channel_type,
        platform_id: routing.platform_id,
        thread_id: routing.thread_id,
        payload: { phase: 'note', text },
      });
      log(`send_message: note → ${routing.resolvedName}`);
      // Not "sent": a note lives in the live progress bubble and is dropped when
      // that bubble collapses. Saying "sent" here taught models to answer the
      // current conversation with this tool and then end the turn silently, so
      // the result now says plainly that the reply still has to be written.
      return ok(
        `${PROCESS_UPDATE_MARKER} Shown to ${routing.resolvedName} as a live progress note — NOT delivered as a message. ` +
          `The note disappears when this turn ends, so your answer must still go in your final reply text.`,
      );
    }

    const { seq } = await enqueueChat(routing, {
      text, ...(Array.isArray(sourceIds) ? { source_email_ids: sourceIds } : {}),
      ...(findings ? { source_email_findings: findings } : {}),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

/** Telegram's bot API caps uploads here; failing early beats a failed delivery. */
const MAX_SEND_BYTES = 50 * 1024 * 1024;

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description:
      'Deliver an attachment. Choose memory for a knowledge-base document or path for a workspace file; supply exactly one source.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'Workspace file path (relative to /workspace/agent/ or absolute)' },
        memory: {
          type: 'string',
          description:
            'Document id or relative file path returned by memory_read or memory_recall (also accepts memory:folder/file.jpg). Sends the original bytes through the host — no workspace copy or extraction needed. Send each original separately for multi-file documents.',
        },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of the file)' },
      },
    },
  },
  async handler(args) {
    const source = resolveSendSource(args);
    if ('error' in source) return err(source.error);
    const route = await resolveRouting(args.to as string | undefined);
    if ('error' in route) return err(route.error);
    const id = generateId();
    let filename: string;
    if ('memory' in source) {
      const result = await getSessionClient().stageMemoryFile(source.memory, id, args.filename as string | undefined);
      if ('error' in result) return err(result.error);
      filename = result.filename;
    } else {
      const bytes = fs.statSync(source.abs).size;
      if (bytes > MAX_SEND_BYTES) return err(`File is ${(bytes / 1048576).toFixed(1)}MB; the messaging limit is 50MB. Send a smaller file or a link.`);
      filename = typeof args.filename === 'string' && args.filename ? args.filename : path.basename(source.abs);
      if (filename === '.' || filename === '..' || /[\\/\0]/.test(filename)) return err('Invalid attachment filename.');
      const directory = path.join('/workspace/outbox', id);
      fs.mkdirSync(directory, { recursive: true });
      fs.copyFileSync(source.abs, path.join(directory, filename));
    }
    await enqueueChat(route, { text: typeof args.text === 'string' ? args.text : '', files: [filename] }, id);
    return ok(`File sent to ${route.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Replace the text of an earlier message in its original conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const number = Number(args.messageId);
    if (!Number.isInteger(number) || number < 1 || typeof args.text !== 'string' || !args.text) return err('messageId and text are required');
    const platformMessage = await getMessageIdBySeq(number);
    if (!platformMessage) return err(`Message #${number} not found`);
    const destination = await getRoutingBySeq(number);
    if (!destination?.channel_type || !destination.platform_id) return err(`Cannot determine destination for message #${number}`);
    await enqueueChat({ ...destination, channel_type: destination.channel_type, platform_id: destination.platform_id, resolvedName: '' }, {
      operation: 'edit', messageId: platformMessage, text: args.text,
    }, generateId(), false);
    return ok(`Message edit queued for #${number}`);
  },
};

registerTools([sendMessage, sendFile, editMessage]);
