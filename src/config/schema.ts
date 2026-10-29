/**
 * Unified Luna config schema — defaults in config/default.jsonc,
 * local overrides in config/local.jsonc (gitignored).
 */

export interface SecretRef {
  env: string;
}

export type SecretOrValue = string | SecretRef | null;

export interface InstallContainerConfig {
  timeoutMs?: number;
  maxOutputSize?: number;
  idleTimeoutMs?: number;
  maxConcurrent?: number;
  maxMessagesPerPrompt?: number;
  installCjkFonts?: boolean;
}

export interface InstallConfig {
  assistantName?: string;
  assistantHasOwnNumber?: boolean;
  timezone?: string;
  container?: InstallContainerConfig;
  onecli?: {
    url?: string | null;
    apiKey?: SecretOrValue;
  };
}

export interface McpServerConfigDoc {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  oneCli?: boolean;
  instructions?: string;
  toolsAllow?: string[];
  toolsIgnore?: string[];
  host?: boolean;
}

export interface AdditionalMountDoc {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export interface AgentConfigDoc {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  imageTag?: string | null;
  assistantName?: string | null;
  cliScope?: 'disabled' | 'agent' | 'global' | 'group';
  maxMessagesPerPrompt?: number;
  context?: {
    maxApproxTokens?: number;
    keepRecentTurns?: number;
    summarization?: 'off' | 'deterministic' | 'model';
    promptCacheKey?: string;
    /** Topic segmentation. Shape mirrors `TopicsConfig` in container-config.ts. */
    topics?: {
      enabled?: boolean;
      classifier?: 'decisions' | 'model';
      continueWindowMinutes?: number;
      injectCount?: number;
      mirrorToMemory?: boolean;
      summaryModel?: 'memory' | 'main';
    };
    /** Pre-turn attachment reading. Mirrors `AttachmentsConfig` in container-config.ts. */
    attachments?: {
      enabled?: boolean;
      deadlineMs?: number;
      maxCharsPerAttachment?: number;
      maxBlockChars?: number;
      maxGistChars?: number;
      maxPdfPages?: number;
      ocrImages?: boolean;
      describeImages?: boolean;
    };
  };
  skills?: string[] | 'all';
  skillsDisabled?: string[];
  skillsEnabled?: string[];
  packages?: { apt?: string[]; npm?: string[] };
  mcpServers?: Record<string, McpServerConfigDoc>;
  additionalMounts?: AdditionalMountDoc[];
}

/** Named endpoint used by models.* roles. */
export type ProviderKind = 'openai-compatible' | 'llama-server-reranker';

export interface NamedProviderConfig {
  /** Defaults to openai-compatible when omitted. */
  kind?: ProviderKind | null;
  baseUrl?: string | null;
  /** Agent transport. Other OpenAI-compatible endpoints can select Chat Completions. */
  api?: 'responses' | 'chat-completions' | null;
  /**
   * `chatgpt` bills the ChatGPT plan Codex is signed in to on this Mac instead of an API key. The
   * host proxies the agent's Responses calls and adds the login, so neither `apiKey` nor `api`
   * applies, and `baseUrl` defaults to the Codex backend.
   */
  auth?: 'api-key' | 'chatgpt' | null;
  /** Secret ref or literal; prefer `{ env: "…" }` in local.jsonc. */
  apiKey?: SecretOrValue;
  /**
   * Env var name holding the API key (alternate to apiKey SecretRef), for a key that must stay
   * named explicitly rather than resolved.
   */
  apiKeyEnv?: string | null;
  /**
   * Extra parameters merged into chat-completion bodies (openai-compatible only).
   */
  extraBody?: Record<string, unknown> | null;
}

/** Map of named providers (openai, lmstudio, llama-reranker, …). */
export type ProvidersConfig = Record<string, NamedProviderConfig | undefined>;

/**
 * One role. Luna talks to one model — the agent's own.
 *
 * There were six. Five of them (embedding, expansion, extraction, reranker, and a spare for
 * background work) existed because Luna configured the memory backend's models on its behalf, and
 * then had to keep two copies of that choice agreeing: provider inheritance between roles,
 * assertions that embedding and expansion shared an endpoint, a formatter turning bare ids into
 * `openai:<id>`, and a sync pass pushing all of it into another database on host start. Memory
 * configures its own models now, in its own config, and none of that has anywhere to disagree.
 */
export type ModelRole = 'main' | 'transcribe';

export interface ModelRoleConfig {
  /** Named key under `providers`. Defaults to "openai". */
  provider?: string | null;
  /** Bare model id (no provider: prefix). */
  id?: string | null;
}

export interface ModelsConfig {
  /** The agent's model. Any OpenAI-compatible endpoint. */
  main?: ModelRoleConfig;
  /**
   * Speech-to-text for inbound voice messages, used only when the macOS recogniser cannot do the
   * job on-device. A separate role because it is a different kind of model — `gpt-transcribe`
   * rather than the agent's own — and because it is reached at `/v1/audio/transcriptions`, which
   * a local whisper.cpp server answers as readily as a hosted endpoint.
   */
  transcribe?: ModelRoleConfig;
}

export type AppleSafetyModeDoc = 'normal' | 'read-only' | 'confirm-destructive';

export interface AppleAppDoc {
  enabled?: boolean;
  /** Gates the in-tree Apple MCP servers: read-only / confirm-destructive. */
  safetyMode?: AppleSafetyModeDoc;
  defaultCalendar?: string | null;
  defaultList?: string | null;
  defaultFolder?: string | null;
}

export interface AppleConfigDoc {
  enabled?: boolean;
  apps?: {
    calendar?: AppleAppDoc;
    reminders?: AppleAppDoc;
    notes?: AppleAppDoc;
    messages?: AppleAppDoc;
    contacts?: AppleAppDoc;
  };
}

/**
 * One person's mailbox. Lives on the *person* (`users.<key>.email`), not in a separate account
 * registry, because a shared assistant has to be able to say whose mail it found — and an account
 * id that is not a roster key gives it no way to.
 */
export interface UserMailboxDoc {
  /** Messages matching either exclusion are inaccessible to mail tools. */
  ignoreLabels?: string[];
  ignoreSenders?: string[];
  /** The Gmail address. Also the SMTP/IMAP login. */
  address?: string;
  /**
   * Gmail app password. Prefer `{ env: "…" }` — the literal form exists only so a value can be
   * passed in tests without a `.env` file.
   */
  appPassword?: SecretOrValue;
  /** What outgoing mail is signed as. Defaults to the roster `name`. */
  displayName?: string | null;
  /** False keeps the mailbox configured but unreachable. Default true. */
  enabled?: boolean;
}

/**
 * Install-wide mail settings. Everything account-shaped moved to `users.<key>.email`.
 *
 * There is no `defaultAccount`, `configPath`, `accounts` or `foldersAllow` here. The first three
 * belonged to a single-mailbox CLI-backed design; `foldersAllow` existed to stop the agent walking
 * a mailbox with hundreds of folders, and there are no folders to walk now — mail is addressed by
 * Gmail search against one open mailbox, and spam and trash are excluded by a query invariant no
 * setting can lift.
 */
export interface EmailConfigDoc {
  /** Install-wide exclusions, additive with each person's mailbox exclusions. */
  ignoreLabels?: string[];
  ignoreSenders?: string[];
  enabled?: boolean;
  /** Which mailbox implementation to use. One today; the seam is what lets a second one land. */
  backend?: 'gmail-imap';
  toolsAllow?: string[];
  /** Per-message body budget before truncation, in characters. */
  maxBodyChars?: number;
}

/**
 * Memory is Akno, running as its own service. Luna configures where to reach it and nothing
 * else: the knowledge base path, the models, the chunking, the maintenance schedule and the
 * retention window are all Akno's own config, in Akno's own file. Two systems configuring one
 * knowledge base is the arrangement that produced model-config sync in three directions.
 */
export interface MemoryConfigDoc {
  /** Default true. False leaves the agent with no memory tools at all. */
  enabled?: boolean;
  /** Default true. Check memory once before each substantive user turn. */
  autoRecall?: boolean;
  /**
   * Unix socket the memory service listens on. Unset means Akno's own default
   * (`~/.akno/akno.sock`), which is what a standard `akno service install` produces.
   */
  socket?: string | null;
  /**
   * Appended to memory's standing rules on every `remember` this install makes — what matters in
   * *this* user's conversations, as opposed to what memory always keeps. Unset is the normal case.
   */
  mission?: string | null;
  /**
   * Learn from conversations: after a turn, hand what the user said to memory and let it decide
   * what lasts. Default true. `/learn off` overrides it for one session.
   */
  digest?: boolean;
  /**
   * How much to say when the digest wrote something.
   *   'off'   — never mention it
   *   'pages' — which pages changed, and how to undo (default)
   */
  notify?: 'off' | 'pages';
}

/**
 * One person Luna will talk to.
 *
 * The map key is an internal reference the operator picks — `ada`, `bo` — and it is the only
 * name for that person anywhere in the install. It also names their hot-memory page (`users/<key>`).
 * Deliberately derived from nothing external: keying a person off a Telegram handle meant that
 * changing the handle orphaned the memory page, and it made a recyclable identifier load-bearing.
 *
 * There is no `telegramUserId` here. The numeric id is observed on first contact, never typed, so it
 * belongs in the `users` table as a learned binding rather than in a file a human maintains.
 */
export interface UserConfigDoc {
  /**
   * What the assistant calls this person. Falls back to the name the platform reports, then to the
   * key itself.
   */
  name?: string | null;
  /** Telegram @handle, without the `@`. Matched case-insensitively. */
  telegramHandle?: string | null;
  /**
   * Durable profile page in memory, e.g. `people/ada-marlow`. Linked from `users/<key>` rather
   * than replacing it: the hot page is a few standing lines, the profile is everything else.
   */
  memoryPage?: string | null;
  /**
   * False refuses their messages while keeping the entry, the memory page and the history. Default
   * true. Deleting the entry is the other way to say this, and loses all three.
   */
  enabled?: boolean;
  /** This person's mailbox. Absent means they have none, and mail tools cannot name them. */
  email?: UserMailboxDoc;
}

/**
 * Hearing voice messages.
 *
 * A received voice note is transcribed on the host before the agent is woken, so what reaches
 * the turn is text the user spoke. Two recognisers, chosen by `backend`.
 */
export interface VoiceConfigDoc {
  /** Default true. False leaves voice messages as bare attachments with no text. */
  enabled?: boolean;
  /**
   * Which recogniser hears it.
   *   'auto'  — macOS on-device when every `languages` entry has an on-device asset, else the
   *             model (default). The choice is made once and logged.
   *   'macos' — on-device only. Free, private, no network; fails on a language macOS lacks.
   *   'model' — always `models.transcribe`. Identifies the language itself, which is what a
   *             household speaking more than one of them wants.
   */
  backend?: 'auto' | 'macos' | 'model';
  /**
   * Languages spoken to this install, most common first, as locale identifiers (`en-US`,
   * `ru-RU`). macOS needs to be told; the transcription model only takes a hint when there is
   * exactly one, and detects it otherwise.
   */
  languages?: string[];
  /** Refuse anything longer, before decoding it. Default 600s. */
  maxDurationSec?: number;
  /** Ceiling for decode plus recognition of one message. Default 120000. */
  deadlineMs?: number;
}

/** Full on-disk config document shape. */
export interface LunaConfigDoc {
  install?: InstallConfig;
  /**
   * The roster: who may talk to this install, keyed by internal reference. Absent or empty means
   * nobody but the host terminal.
   */
  users?: Record<string, UserConfigDoc>;
  /**
   * The one owner, by `users` key. Owner-only commands and approval cards resolve to this person.
   * Exactly one — a second owner is not expressible, which is the point.
   */
  owner?: string | null;
  /** Named endpoints (openai, lmstudio, …). */
  providers?: ProvidersConfig;
  /** Role bindings: main (agent), embedding, expansion, reranker. */
  models?: ModelsConfig;
  /** Unified MCP wiring (in-container + host-routed servers). */
  mcpServers?: Record<string, McpServerConfigDoc>;
  /** Host port for host MCP HTTP bridge. */
  mcpPort?: number;
  agent?: AgentConfigDoc;
  memory?: MemoryConfigDoc;
  apple?: AppleConfigDoc;
  email?: EmailConfigDoc;
  voice?: VoiceConfigDoc;
}
