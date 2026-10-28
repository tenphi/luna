import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const factories: Record<string, ChannelRegistration> = Object.create(null);
const live: Record<string, ChannelAdapter> = Object.create(null);

export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  factories[name] = registration;
}
export const getChannelAdapter = (name: string): ChannelAdapter | undefined => live[name];
export const getActiveAdapters = (): ChannelAdapter[] => Object.values(live);
export const getRegisteredChannelNames = (): string[] => Object.keys(factories);
export const getChannelContainerConfig = (name: string): ChannelRegistration['containerConfig'] =>
  factories[name]?.containerConfig;

async function start(adapter: ChannelAdapter, setup: ChannelSetup): Promise<void> {
  for (const pause of [0, 2000, 5000, 10000]) {
    if (pause) await delay(pause);
    try {
      await adapter.setup(setup);
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'NetworkError' || pause === 10000) throw error;
      log.warn('Retrying a channel connection after a network failure', { channel: adapter.channelType });
    }
  }
}

export async function initChannelAdapters(setup: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  for (const [name, registration] of Object.entries(factories)) {
    try {
      const candidate = await registration.factory();
      if (candidate === null) {
        log.warn('Channel has no configured credentials', { channel: name });
        continue;
      }
      await start(candidate, setup(candidate));
      live[candidate.channelType] = candidate;
      log.info('Channel is ready', { channel: candidate.channelType });
    } catch (error) {
      log.error('Channel initialization failed', { channel: name, error });
    }
  }
}

export async function teardownChannelAdapters(): Promise<void> {
  const closing = Object.values(live);
  for (const name of Object.keys(live)) delete live[name];
  for (const adapter of closing) {
    try {
      await adapter.teardown();
    } catch (error) {
      log.error('Channel shutdown failed', { channel: adapter.channelType, error });
    }
  }
}
