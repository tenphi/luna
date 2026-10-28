import { log } from './log.js';

export type ResponsePayload = {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
};
export type ResponseHandler = (response: ResponsePayload) => Promise<boolean>;
type ShutdownCallback = () => void | Promise<void>;
const handlers: ResponseHandler[] = [];
const shutdown: ShutdownCallback[] = [];
export function registerResponseHandler(handler: ResponseHandler): void {
  handlers.push(handler);
}
export function onShutdown(callback: ShutdownCallback): void {
  shutdown.push(callback);
}
export const getShutdownCallbacks = (): readonly ShutdownCallback[] => shutdown.slice();

/** Each handler may claim the response; a failed handler cannot prevent the next one. */
export async function dispatchResponse(response: ResponsePayload): Promise<boolean> {
  const candidates = handlers.slice();
  while (candidates.length) {
    try {
      if (await candidates.shift()!(response)) return true;
    } catch (error) {
      log.error('Interactive response handler failed', { questionId: response.questionId, error });
    }
  }
  log.warn('No handler claimed an interactive response', { questionId: response.questionId });
  return false;
}
