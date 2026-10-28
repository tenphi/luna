/**
 * Terminal chat with your Luna agent (legacy entry point).
 *
 * Usage:
 *   pnpm run chat <message...>
 *
 * Delegates to `luna ask`. Prefer `luna ask` or bare `luna` for interactive chat.
 */
import { runChatClient } from '../src/cli/chat-client.js';

const words = process.argv.slice(2);
if (words.length === 0) {
  console.error('usage: pnpm run chat <message...>');
  console.error('       luna ask <message...>   (preferred)');
  process.exit(1);
}

runChatClient({ mode: 'ask', message: words.join(' ') })
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
