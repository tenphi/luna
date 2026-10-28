
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { confirmThenOpen, formatNoteLink, openUrl } from '../lib/browser.js';
import {
  type Block,
  type StepResult,
  dumpTranscriptOnFailure,
  ensureAnswer,
  fail,
  runQuietChild,
  spawnStep,
  writeStepEntry,
} from '../lib/runner.js';
import { readEnvKey } from '../environment.js';
import { accentGreen, fitToWidth, fmtDuration, note } from '../lib/theme.js';

import { DEFAULT_AGENT_NAME } from '../lib/default-agent-name.js';
import { suggestUserKey } from '../users.js';
import { registerTelegramBotCommands } from '../../src/channels/telegram-bot-commands.js';

export async function runTelegramChannel(displayName: string): Promise<ChannelFlowResult> {
  const tokenOrBack = await collectTelegramToken();
  if (tokenOrBack === 'back') return BACK_TO_CHANNEL_SELECTION;
  const token = tokenOrBack;
  const botUsername = await validateTelegramToken(token);

  
  const botUrl = `https://t.me/${botUsername}`;
  note(`Open @${botUsername} in Telegram and send the pairing code shown next.`, 'Open Telegram');
  await confirmThenOpen(botUrl, 'Open Telegram for pairing?');

  const install = await runQuietChild(
    'telegram-install',
    'pnpm',
    ['exec', 'tsx', 'setup/index.ts', '--step', 'telegram'],
    {
      running: `Connecting Telegram to @${botUsername}…`,
      done: 'Telegram connected.',
    },
    {
      env: { TELEGRAM_BOT_TOKEN: token },
      extraFields: { BOT_USERNAME: botUsername },
    },
  );
  if (!install.ok) {
    await fail(
      'telegram-install',
      "Couldn't connect Telegram.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  await registerBotCommandsDuringSetup(token);

  // The roster is written before the bot is ever messaged, because it is what decides whose message
  // counts. There is no role question any more: the owner is a key in config, and exactly one exists.
  const ownerHandle = await askOwnerHandle();
  const ownerKey = await askOwnerKey(displayName);
  const others = await askOtherPeople();

  const roster = await runQuietChild(
    'users',
    'pnpm',
    [
      'exec',
      'tsx',
      'setup/index.ts',
      '--step',
      'users',
      '--owner-key',
      ownerKey,
      '--owner-name',
      displayName,
      '--owner-handle',
      ownerHandle,
      ...others.flatMap((p) => ['--user', `${p.key}:${p.name}:${p.handle}`]),
    ],
    {
      running: 'Writing your roster…',
      done:
        others.length > 0
          ? `Roster saved: you and ${others.length} other${others.length === 1 ? '' : 's'}.`
          : 'Roster saved.',
    },
    { extraFields: { OWNER_KEY: ownerKey, OWNER_HANDLE: ownerHandle } },
  );
  if (!roster.ok) {
    await fail('users', "Couldn't save your roster.", 'See logs/setup-steps/ for the reason, then re-run setup.');
  }

  const bind = await runBindTelegram(botUsername);
  if (!bind.ok) {
    await fail(
      'bind-telegram',
      "Didn't hear from you on Telegram.",
      `Message @${botUsername} and re-run setup, or check that @${ownerHandle} is the right handle.`,
    );
  }

  const platformId = bind.terminal?.fields.PLATFORM_ID ?? '';
  const pairedUserId = bind.terminal?.fields.PAIRED_USER_ID ?? '';
  if (!platformId || !pairedUserId) {
    await fail('bind-telegram', 'Telegram connected but came back incomplete.', 'Re-run setup to try again.');
  }

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/init-first-agent.ts',
      '--channel',
      'telegram',
      '--user-id',
      pairedUserId!,
      '--platform-id',
      platformId!,
      '--display-name',
      displayName,
      '--agent-name',
      agentName,
    ],
    {
      running: `Connecting ${agentName} to your Telegram chat…`,
      done: `${agentName} is ready. Check Telegram for a welcome message.`,
    },
    {
      extraFields: { CHANNEL: 'telegram', AGENT_NAME: agentName, PLATFORM_ID: platformId },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later by re-running setup or `scripts/init-first-agent.ts`.',
    );
  }
}

const validToken = (value: string): boolean => /^[0-9]+:[A-Za-z0-9_-]{35,}$/.test(value);
async function collectTelegramToken(): Promise<string | 'back'> {
  const saved = readEnvKey('TELEGRAM_BOT_TOKEN');
  const options =
    saved && validToken(saved)
      ? [
          { value: 'reuse', label: 'Use the saved bot token' },
          { value: 'new', label: 'Connect a different bot' },
        ]
      : [{ value: 'new', label: 'Connect a Telegram bot' }];
  const choice = ensureAnswer(
    await p.select({
      message: 'Telegram connection',
      options: [...options, { value: 'back', label: 'Back to setup options' }],
    }),
  );
  if (choice === 'back') return 'back';
  if (choice === 'reuse' && saved) return saved;
  note(
    `Open Telegram’s @BotFather, send /newbot, and follow its instructions. Copy the bot token into the next prompt.

For shared groups, disable Group Privacy in BotFather’s bot settings so Luna can read the conversation.`,
    'Create your bot',
  );
  const token = ensureAnswer(
    await p.password({
      message: 'Bot token',
      validate: (value) => (value && validToken(value.trim()) ? undefined : 'Enter the token supplied by BotFather'),
    }),
  ).trim();
  setupLog.userInput('telegram_token', '[redacted]');
  return token;
}
async function validateTelegramToken(token: string): Promise<string> {
  const spinner = p.spinner();
  const started = Date.now();
  spinner.start('Verifying the Telegram bot…');
  let username: string | undefined;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
    const result = (await response.json()) as { ok?: boolean; result?: { username?: string } };
    if (response.ok && result.ok) username = result.result?.username;
  } catch {
    /* Avoid including the credential-bearing URL in an error. */
  }
  spinner.stop(username ? `Connected to @${username}.` : 'Telegram could not verify the token.');
  setupLog.step('telegram-validate', username ? 'success' : 'failed', Date.now() - started, { BOT_USERNAME: username });
  if (!username) return fail('telegram-validate', 'Check the token and your connection, then retry setup.');
  return username;
}

async function registerBotCommandsDuringSetup(token: string): Promise<void> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Registering Telegram bot commands…');
  const result = await registerTelegramBotCommands(token);
  const durationMs = Date.now() - start;
  if (result.ok) {
    s.stop(`Bot commands registered. ${k.dim(`(${fmtDuration(durationMs)})`)}`);
    setupLog.step('telegram-bot-commands', 'success', durationMs, {
      SCOPES: String(result.scopes),
    });
    return;
  }
  s.stop(`Couldn't register bot commands: ${result.error}`);
  setupLog.step('telegram-bot-commands', 'failed', durationMs, {
    ERROR: result.error,
  });
  note(
    [
      'Telegram did not accept the command menu update.',
      'The bot still works — the host will retry on next start.',
      `Reason: ${result.error}`,
    ].join('\n'),
    'Bot commands',
  );
}

/**
 * Ask who owns this install, on Telegram.
 *
 * The handle is what an inbound message is matched against, so it is the one answer here that decides
 * whether anyone can reach the assistant at all. A wrong one fails closed — nobody binds — rather than
 * admitting the wrong person, and the host terminal keeps working either way.
 */
async function askOwnerHandle(): Promise<string> {
  const preset = process.env.LUNA_OWNER_TELEGRAM_HANDLE?.trim().replace(/^@+/, '');
  if (preset) {
    setupLog.userInput('owner_telegram_handle', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: `What's your Telegram username? ${k.dim('(the @handle people use to find you)')}`,
      placeholder: '@yourname',
      validate: (v) => {
        const cleaned = (v ?? '').trim().replace(/^@+/, '');
        if (!cleaned) return 'Required — this is how I know which messages are yours.';
        if (!/^[A-Za-z0-9_]{4,32}$/.test(cleaned)) {
          return 'Telegram usernames are 4-32 characters: letters, digits and underscores.';
        }
        return undefined;
      },
    }),
  );
  const handle = (answer as string).trim().replace(/^@+/, '');
  setupLog.userInput('owner_telegram_handle', handle);
  return handle;
}

/**
 * The owner's config key — their name everywhere inside the install, including their memory page.
 *
 * Offered as a default rather than asked outright, because most operators have no reason to care. It
 * matters that it is *not* the Telegram handle: handles change, and this key names a memory page.
 */
async function askOwnerKey(displayName: string): Promise<string> {
  const preset = process.env.LUNA_OWNER_KEY?.trim();
  if (preset) {
    setupLog.userInput('owner_key', preset);
    return preset;
  }
  const suggested = suggestUserKey(displayName);
  const answer = ensureAnswer(
    await p.text({
      message: `Short name to file your notes under? ${k.dim(`(memory page: users/${suggested})`)}`,
      placeholder: suggested,
      defaultValue: suggested,
      validate: (v) => {
        const raw = (v ?? '').trim();
        if (!raw) return undefined;
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw)) {
          return 'Lowercase letters, digits, "-" or "_", starting with a letter or digit.';
        }
        return undefined;
      },
    }),
  );
  const key = ((answer as string) || suggested).trim();
  setupLog.userInput('owner_key', key);
  return key;
}

interface ExtraPerson {
  key: string;
  name: string;
  handle: string;
}

/** Anyone else allowed to talk to the assistant. Empty is the common answer. */
async function askOtherPeople(): Promise<ExtraPerson[]> {
  const people: ExtraPerson[] = [];

  for (;;) {
    const choice = ensureAnswer(
      await p.select<'add' | 'done'>({
        message:
          people.length === 0
            ? 'Anyone else allowed to talk to your assistant?'
            : `Added ${people.length}. Anyone else?`,
        options: [
          { value: 'done', label: people.length === 0 ? 'No, just me' : "No, that's everyone" },
          { value: 'add', label: 'Yes, add someone' },
        ],
        initialValue: 'done',
      }),
    );
    if (choice === 'done') break;

    const name = (
      ensureAnswer(
        await p.text({
          message: 'Their name?',
          validate: (v) => ((v ?? '').trim() ? undefined : 'Required'),
        }),
      ) as string
    ).trim();

    const handle = (
      ensureAnswer(
        await p.text({
          message: `${name}'s Telegram username?`,
          placeholder: '@theirname',
          validate: (v) => {
            const cleaned = (v ?? '').trim().replace(/^@+/, '');
            if (!cleaned) return 'Required — without it I cannot tell their messages apart.';
            if (!/^[A-Za-z0-9_]{4,32}$/.test(cleaned)) {
              return 'Telegram usernames are 4-32 characters: letters, digits and underscores.';
            }
            return undefined;
          },
        }),
      ) as string
    )
      .trim()
      .replace(/^@+/, '');

    const key = suggestUserKey(name);
    // Keys name memory pages, so a collision would file two people in one place.
    if (people.some((x) => x.key === key)) {
      note(`Already added someone filed under "${key}" — skipping.`, 'Duplicate');
      continue;
    }
    people.push({ key, name, handle });
    setupLog.userInput('extra_user', `${key}=@${handle}`);
  }

  return people;
}

/**
 * Wait for the owner's first message, which is what supplies their numeric chat id.
 *
 * Unavoidable on Telegram: a bot cannot open a conversation, so the chat has to start from their side.
 * What changed is what the wait is *for* — no longer proving they control the account (the roster does
 * that), just learning where to reach them.
 */
async function runBindTelegram(botUsername: string): Promise<StepResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog('bind-telegram');
  const start = Date.now();
  const s = p.spinner();
  s.start('Getting ready…');
  let spinnerActive = true;

  const stopSpinner = (msg: string, code?: number) => {
    if (spinnerActive) {
      s.stop(msg);
      spinnerActive = false;
    }
  };

  const result = await spawnStep(
    'bind-telegram',
    [],
    (block: Block) => {
      if (block.type === 'BIND_TELEGRAM_WAITING') {
        stopSpinner('Roster ready.');
        note(
          [
            `Send @${botUsername} any message from Telegram — "hi" is plenty.`,
            '',
            k.dim(`I'm watching for @${block.fields.HANDLE ?? 'you'}, so it has to come from that account.`),
          ].join('\n'),
          'Say hello',
        );
        s.start(fitToWidth('Waiting for your message…', ''));
        spinnerActive = true;
      } else if (block.type === 'BIND_TELEGRAM') {
        if (block.fields.STATUS === 'success') {
          stopSpinner('Found you.');
        } else {
          stopSpinner(`Couldn't connect: ${block.fields.ERROR ?? 'unknown'}`, 1);
        }
      }
    },
    rawLog,
  );
  const durationMs = Date.now() - start;

  if (spinnerActive) {
    stopSpinner(result.ok ? 'Done.' : 'Ended unexpectedly.', result.ok ? 0 : 1);
    if (!result.ok) dumpTranscriptOnFailure(result.transcript);
  }

  writeStepEntry('bind-telegram', result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.LUNA_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: `What should your ${accentGreen('assistant')} be called?`,
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}
