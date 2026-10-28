import { emitStatus } from './status.js';
import { optionValue } from './lib/arguments.js';

const names = ['timezone', 'set-env', 'environment', 'container', 'register', 'users', 'bind-telegram', 'mounts', 'service', 'verify', 'onecli', 'auth', 'cli-agent', 'apple', 'email', 'tavily', 'telegram'];
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(`Luna setup: --apply or --step ${names.join('|')}`); return; }
  const step = args.includes('--apply') ? 'apply' : optionValue(args, '--step');
  if (!step || (step !== 'apply' && !names.includes(step))) throw new Error(`Choose --apply or --step ${names.join('|')}`);
  const position = args.indexOf('--step');
  const options = step === 'apply' ? [] : args.filter((argument, index) => argument !== '--' && (position < 0 || (index !== position && index !== position + 1)) && !argument.startsWith('--step='));
  try {
    const implementation = await import(new URL(`./${step}.js`, import.meta.url).href);
    await implementation.run(options);
  } catch (error) {
    emitStatus(step.toUpperCase(), { STATUS: 'failed', ERROR: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
