import { randomUUID } from 'node:crypto';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/** Deterministic provider for local tests and development without network access. */
export class MockProvider implements AgentProvider {
  private readonly respond: (prompt: string) => string;
  constructor(_options: ProviderOptions = {}, responseFactory?: (prompt: string) => string) {
    this.respond = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
  }
  isSessionInvalid(_error: unknown): boolean {
    return false;
  }
  query(input: QueryInput): AgentQuery {
    let controller!: ReadableStreamDefaultController<string>;
    let closed = false;
    const stream = new ReadableStream<string>({
      start(value) {
        controller = value;
        value.enqueue(input.prompt);
      },
    });
    const respond = this.respond;
    const finish = () => {
      if (!closed) {
        closed = true;
        controller.close();
      }
    };
    return {
      end: finish,
      abort: finish,
      push(prompt) {
        if (!closed) controller.enqueue(prompt);
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
          yield { type: 'activity' };
          yield { type: 'init', continuation: `mock-session-${randomUUID()}` };
          const reader = stream.getReader();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) return;
              yield { type: 'activity' };
              yield { type: 'result', text: respond(next.value) };
            }
          } finally {
            reader.releaseLock();
          }
        },
      },
    };
  }
}
registerProvider('mock', (options) => new MockProvider(options));
