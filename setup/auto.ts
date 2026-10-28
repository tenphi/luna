import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import k from 'kleur';
import { persistOpenAiEndpoint, stripSetupLocalEnvKeys } from '../src/config/setup-persist.js';
import { loadLunaConfig } from '../src/config/loader.js';
import { resolveAssistantName } from '../src/config/unified-agent.js';
import { writeLocalConfig } from '../src/config/write.js';
import { ownerKey, rosterUser } from '../src/users/roster.js';
import { isValidTimezone } from '../src/timezone.js';
import { runTelegramChannel } from './channels/telegram.js';
import { BACK_TO_CHANNEL_SELECTION } from './lib/back-nav.js';
import { pingCliAgent } from './lib/agent-ping.js';
import { getOnecliApiHost } from './onecli.js';
import {
  applyToEnv,
  parseFlags,
  printHelp,
  readFromDotenv,
  readFromEnv,
  readFromUnifiedConfig,
} from './lib/setup-config-parse.js';
import { runAdvancedScreen } from './lib/setup-config-screen.js';
import { ensureAnswer, fail, runQuietChild, runQuietStep } from './lib/runner.js';
import { brandBody, brandBold, note } from './lib/theme.js';
import * as setupLog from './logs.js';

async function requiredStep(name: string, running: string, extra: string[] = []): Promise<void> {
  const result = await runQuietStep(name, { running, done: 'Ready.', skipped: 'Already configured.' }, extra);
  if (!result.ok)
    await fail(
      name,
      `Could not complete ${name}.`,
      result.terminal?.fields.HINT ?? 'See the setup log for details.',
      result.rawLog,
    );
}
async function connectGateway(): Promise<void> {
  const remote = process.env.LUNA_ONECLI_API_HOST?.trim();
  let extra = remote ? ['--remote-url', remote] : [];
  if (!remote) {
    const existing = getOnecliApiHost();
    if (
      existing &&
      ensureAnswer(await p.confirm({ message: `Use the existing OneCLI gateway at ${existing}?`, initialValue: true }))
    )
      extra = ['--reuse'];
  }
  await requiredStep('onecli', 'Connecting the credential gateway…', extra);
}
async function selectTimezone(): Promise<void> {
  const current = loadLunaConfig().install?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const accepted =
    isValidTimezone(current) &&
    ensureAnswer(await p.confirm({ message: `Use ${current} as your timezone?`, initialValue: true }));
  const zone = accepted
    ? current
    : ensureAnswer(
        await p.text({
          message: 'Timezone (IANA name)',
          placeholder: 'America/New_York',
          validate: (value) => (value && isValidTimezone(value.trim()) ? undefined : 'Enter a valid IANA timezone'),
        }),
      ).trim();
  await requiredStep('timezone', 'Saving the timezone…', ['--tz', zone]);
}
async function displayName(): Promise<string> {
  const config = loadLunaConfig();
  const stored = rosterUser(ownerKey(config), config)?.name;
  if (process.env.LUNA_DISPLAY_NAME?.trim()) return process.env.LUNA_DISPLAY_NAME.trim();
  if (stored && stored !== ownerKey(config)) return stored;
  const name = ensureAnswer(
    await p.text({
      message: 'What should Luna call you?',
      defaultValue: 'Operator',
      validate: (value) => (value?.trim() ? undefined : 'Enter a name'),
    }),
  ).trim();
  setupLog.userInput('display_name', name);
  return name;
}
async function testAssistant(): Promise<void> {
  if (
    !ensureAnswer(
      await p.confirm({ message: 'Send a quick test message to verify the model connection?', initialValue: true }),
    )
  )
    return;
  const spinner = p.spinner();
  spinner.start('Waiting for Luna to answer…');
  const result = await pingCliAgent(60_000);
  spinner.stop(result === 'ok' ? 'Luna replied.' : 'The connection needs attention.');
  if (result !== 'ok')
    p.log.warn(
      result === 'auth_error'
        ? 'Check the model API key, then try `luna ask hi`.'
        : 'Check logs/luna.error.log and try `luna ask hi` after correcting the connection.',
    );
}
async function main(): Promise<void> {
  const started = Date.now();
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }
  if (flags.errors.length) throw new Error(flags.errors.join('\n'));
  const localBin = path.join(os.homedir(), '.local', 'bin');
  process.env.PATH = [
    localBin,
    ...(process.env.PATH ?? '').split(path.delimiter).filter((item) => item !== localBin),
  ].join(path.delimiter);
  if (process.env.LUNA_BOOTSTRAPPED !== '1') setupLog.reset({ invocation: 'setup:auto', cwd: process.cwd() });
  p.intro(brandBold('Set up Luna'));
  let settings = { ...readFromDotenv(), ...readFromUnifiedConfig(), ...readFromEnv(), ...flags.values };
  const choice = ensureAnswer(
    await p.select({
      message: 'Setup options',
      initialValue: 'default',
      options: [
        { value: 'default', label: 'Use recommended defaults' },
        { value: 'advanced', label: 'Change optional settings' },
      ],
    }),
  );
  if (choice === 'advanced') settings = await runAdvancedScreen(settings);
  applyToEnv(settings);
  const skip = new Set(
    (process.env.LUNA_SKIP ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (!skip.has('environment')) await requiredStep('environment', 'Checking macOS and required tools…');
  if (!skip.has('container')) {
    p.log.info('The first sandbox build can take several minutes. Build output is saved under logs/setup-steps/.');
    await requiredStep('container', 'Building the agent sandbox…');
  }
  if (!skip.has('onecli')) await connectGateway();
  if (!skip.has('auth')) await runAuthStep();
  if (!skip.has('memory')) await configureOptionalMemory();
  if (!skip.has('mounts')) await requiredStep('mounts', 'Preparing the folder access policy…', ['--empty']);
  const name = await displayName();
  if (!skip.has('cli-agent'))
    await requiredStep('cli-agent', 'Preparing Luna…', [
      '--display-name',
      name,
      '--agent-name',
      resolveAssistantName(loadLunaConfig()) || 'Luna',
    ]);
  if (!skip.has('timezone')) await selectTimezone();
  if (!skip.has('service')) await requiredStep('service', 'Starting the background service…');
  if (!skip.has('first-chat')) await testAssistant();
  let connected = false;
  if (!skip.has('channel'))
    for (;;) {
      const selected = ensureAnswer(
        await p.select({
          message: 'Connect Telegram?',
          initialValue: 'telegram',
          options: [
            { value: 'telegram', label: 'Set up a Telegram bot', hint: 'recommended' },
            { value: 'skip', label: 'Use the terminal for now' },
          ],
        }),
      );
      if (selected === 'skip') break;
      if ((await runTelegramChannel(name)) === BACK_TO_CHANNEL_SELECTION) continue;
      connected = true;
      break;
    }
  if (!skip.has('verify')) {
    const result = await runQuietStep('verify', {
      running: 'Verifying the installation…',
      done: 'Installation verified.',
      failed: 'Verification needs attention.',
    });
    if (!result.ok) {
      stripSetupLocalEnvKeys();
      note('See logs/setup.log, fix the reported connection, then run `luna setup step verify`.', 'Finish setup');
      p.outro('Setup saved; verification is incomplete.');
      process.exitCode = 1;
      return;
    }
  }
  stripSetupLocalEnvKeys();
  setupLog.complete(Date.now() - started);
  note(
    'Chat with `luna` or `luna ask hi`. Luna remains available while this Mac is awake and online.',
    'Your assistant',
  );
  p.outro(connected ? 'Ready. Open Telegram to see Luna’s welcome.' : 'Ready to chat from the terminal.');
}

async function runAuthStep(): Promise<void> {
  const baseUrl = process.env.LUNA_OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const apiKey = process.env.LUNA_OPENAI_API_KEY?.trim() || '';
  const model = process.env.LUNA_OPENAI_MODEL?.trim() || 'gpt-6-luna';
  const local = new URL(baseUrl).hostname !== 'api.openai.com';
  await runOpenAIEndpointAuth({ baseUrl, apiKey, model, interactive: !apiKey && !local });
}

async function configureOptionalMemory(): Promise<void> {
  p.log.info(
    brandBody(
      'Recommended: install Akno for durable knowledge, using its own setup flow at https://akno.tenphi.me/getting-started. Luna can run without it.',
    ),
  );
  const connect = ensureAnswer(
    await p.confirm({
      message: 'Connect an already configured Akno service?',
      initialValue: loadLunaConfig().memory?.enabled ?? false,
    }),
  );
  if (!connect) {
    writeLocalConfig({ memory: { enabled: false } });
    return;
  }
  const socket = ensureAnswer(
    await p.text({
      message: 'Akno socket (leave blank for ~/.akno/akno.sock)',
      initialValue: loadLunaConfig().memory?.socket || '',
    }),
  ) as string;
  const resolved = socket.trim() || path.join(os.homedir(), '.akno', 'akno.sock');
  if (!fs.existsSync(resolved)) {
    p.log.warn(
      brandBody(
        'No Akno socket found. Continuing without memory; finish Akno setup and enable it with luna config memory set --enabled true.',
      ),
    );
    writeLocalConfig({ memory: { enabled: false } });
    return;
  }
  writeLocalConfig({ memory: { enabled: true, socket: socket.trim() || null } });
}

/**
 * Configure an OpenAI-compatible endpoint. Prompts for base URL (default
 * https://api.openai.com/v1), an API key (optional only for other endpoints),
 * and, for other endpoints, a model picked from their /models list when
 * reachable. Persists endpoint + model to config/local.jsonc (API key to .env)
 * and registers the host-side openai provider so the runtime passes the
 * endpoint config into containers.
 */
async function runOpenAIEndpointAuth(opts: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  interactive: boolean;
}): Promise<void> {
  const start = Date.now();
  let baseUrl = opts.baseUrl?.trim() || '';
  let apiKey = opts.apiKey?.trim() || '';
  let model = opts.model?.trim() || 'gpt-6-luna';

  if (opts.interactive) {
    baseUrl = (
      ensureAnswer(
        await p.text({
          message: 'OpenAI-compatible endpoint base URL',
          placeholder: 'https://api.openai.com/v1',
          initialValue: baseUrl || 'https://api.openai.com/v1',
          validate: (v) => {
            const val = (v ?? '').trim();
            if (!val) return 'Required';
            try {
              new URL(val);
            } catch {
              return 'Enter a valid URL, e.g. https://api.openai.com/v1';
            }
            return undefined;
          },
        }),
      ) as string
    ).trim();

    const keyRequired = new URL(baseUrl).hostname === 'api.openai.com';
    apiKey = (
      ensureAnswer(
        await p.password({
          message: keyRequired ? 'OpenAI API key' : 'API key (leave blank for a local server that needs none)',
          validate: (v) => (keyRequired && !(v ?? '').trim() ? 'OpenAI requires an API key' : undefined),
        }),
      ) as string
    ).trim();
  }

  if (!baseUrl) baseUrl = 'https://api.openai.com/v1';

  let models: string[] = [];

  // Try to list models from the endpoint so the user can pick one.
  if (opts.interactive && new URL(baseUrl).hostname !== 'api.openai.com') {
    models = await fetchOpenAiModels(baseUrl, apiKey);
    if (models.length > 0) {
      model = ensureAnswer(
        await p.select({
          message: 'Which model should the assistant use?',
          options: models.slice(0, 50).map((m) => ({ value: m, label: m })),
          initialValue: model && models.includes(model) ? model : undefined,
        }),
      ) as string;
    } else {
      p.log.warn(brandBody("Couldn't fetch the model list from the endpoint — you can type the model name manually."));
      model = (
        ensureAnswer(
          await p.text({
            message: 'Model name',
            placeholder: 'gpt-6-luna',
            initialValue: model,
            validate: (v) => ((v ?? '').trim() ? undefined : 'Required'),
          }),
        ) as string
      ).trim();
    }
    setupLog.userInput('openai_model', model);
  }

  // Non-secrets → local.jsonc; API key → .env. Runtime reads unified config.
  persistOpenAiEndpoint({
    baseUrl,
    apiKey: apiKey || undefined,
    model: model || undefined,
    provider: 'openai',
  });

  // Optionally store the key in OneCLI too, keyed to the endpoint host, so the
  // gateway can inject it on the wire. Best-effort — skip silently if OneCLI
  // isn't available or the endpoint is keyless.
  if (apiKey) {
    let host = '';
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      host = '';
    }
    if (host) {
      await runQuietChild(
        'auth',
        'onecli',
        [
          'secrets',
          'create',
          '--name',
          'OpenAI',
          '--type',
          'generic',
          '--value',
          apiKey,
          '--host-pattern',
          host,
          '--header-name',
          'Authorization',
          '--value-format',
          'Bearer {value}',
        ],
        {
          running: 'Saving your API key to your OneCLI vault…',
          done: 'API key saved.',
        },
        { extraFields: { METHOD: 'openai-endpoint', HOST: host } },
      ).catch(() => ({ ok: false }));
    }
  }

  // Memory prompts for its own models — `akno doctor` reports what resolved. This step only
  // establishes the agent's endpoint.

  setupLog.step('auth', opts.interactive ? 'interactive' : 'success', Date.now() - start, {
    METHOD: 'openai-endpoint',
    BASE_URL: baseUrl,
    MODEL: model || '(default)',
    KEY: apiKey ? 'set' : 'none',
  });
  p.log.success(brandBody(`Connected to ${baseUrl}${model ? ` (${model})` : ''}.`));
}

async function fetchOpenAiModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return (body.data || []).flatMap((entry) => (entry.id ? [entry.id] : []));
  } catch {
    return [];
  }
}

main().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  p.cancel('Setup stopped.');
  process.exitCode = 1;
});
