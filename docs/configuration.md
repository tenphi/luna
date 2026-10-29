---
title: Configuration
---

# Configuration

Luna reads two configuration layers: committed defaults in `config/default.jsonc`, followed by your private `config/local.jsonc`. Secrets are referenced by environment-variable name and stored in the private `.env` where setup needs them.

For an npm install, these paths are under `~/.luna`, or your `LUNA_HOME`. Source installs use the checkout directory. Never commit the local overlay or `.env`.

## Recommended defaults

| Setting                | Default                                              |
| ---------------------- | ---------------------------------------------------- |
| Model endpoint         | `https://api.openai.com/v1`                          |
| Chat model             | `gpt-6-luna`                                         |
| Agent reasoning effort | `adaptive`: Decisions selects low, medium, or high   |
| Messaging              | Telegram recommended; terminal chat also available   |
| Durable knowledge      | Disabled until an existing Akno service is connected |
| Email                  | Disabled until configured                            |
| Apple Messages         | Disabled                                             |

Luna uses one main language model for its agent and background conversation work. Embeddings belong to Akno; choose `text-embedding-3-small` in Akno's OpenAI preset. Luna has no separate embedding setup.

The main agent uses OpenAI Responses with thinking enabled. Adaptive effort uses a small Decisions request once per turn, with a one-second deadline and a medium fallback. Set `agent.effort` to a fixed supported level to skip that selector. See [agent behavior](reproducibility.md) and the [official model reference](https://developers.openai.com/api/docs/models/gpt-6-luna). A compatible endpoint can select `providers.<name>.api: "chat-completions"` and its own model and provider parameters.

## ChatGPT subscription

The main model can use the ChatGPT plan that Codex is signed in to on this Mac instead of an API key. Sign in to Codex with a ChatGPT account, then add a provider with `auth: "chatgpt"` and point `models.main` at it:

```jsonc
{
  "providers": {
    "openai": { "baseUrl": "https://api.openai.com/v1", "apiKey": { "env": "OPENAI_API_KEY" } },
    "chatgpt": { "auth": "chatgpt" },
  },
  "models": {
    "main": { "provider": "chatgpt", "id": "gpt-6-luna" },
    "transcribe": { "provider": "openai", "id": "gpt-transcribe" },
  },
}
```

The host reads Codex's login from `$CODEX_HOME/auth.json` (default `~/.codex`) on every model call and forwards the agent's Responses requests with it. The login never enters a container. Luna does not refresh it, because Codex rotates refresh tokens on use; keep the ChatGPT app or `codex login` signed in. `luna health` reports a missing or expired login.

Keep transcription on an API-key provider: the subscription serves only the agent's Responses calls. It has no Decisions endpoint, so adaptive effort falls back to medium unless `agent.effort` is set, and topic routing uses the model classifier. Usage counts against the plan's limits rather than API billing.

## Inspect and change settings

```bash
luna config
luna config models get
luna config models set --role main --provider openai --id gpt-6-luna
luna config agent get
luna config memory get
luna config apple get
luna config email get
```

`luna help --all` lists the advanced command surface. Setup's Advanced menu exposes endpoint and install settings without requiring JSON editing.

## Users

The `users` object is the roster of people admitted to the install; `owner` names its sole owner by key. Setup writes it. New senders are refused unless you configure them on the host. Telegram handles bind to platform identities on first contact.

```jsonc
{
  "users": {
    "ada": { "name": "Ada Marlow", "telegramHandle": "ada_marlow" },
    "bo": { "name": "Bo Winters", "telegramHandle": "bo_winters" },
  },
  "owner": "ada",
}
```

These are invented examples. The local terminal is always privileged through its protected socket; it can repair a mistaken roster.

Several roster entries use the same bot and Akno knowledge base. Per-person profiles help Luna recognize whose preference or conversation she is using; they do not turn the shared knowledge base into private per-user stores. Apple services use the hosting Mac's accounts, so choose shared calendars and reminder lists for shared use. See [Telegram and shared use](telegram.md).

## Runtime changes

Settings are loaded by the host and included in new agent sessions. After editing the local overlay, run `luna redeploy --no-build` to recycle the runtime. Use `luna redeploy` after changing source code, and upgrade/restart Akno separately after changing it.

## Credentials

Never put a key into a prompt, skill, or Markdown knowledge page. `.env` is a private plaintext file, so protect the install directory and backups. OneCLI can hold tool credentials and inject them into requests. Direct provider configuration can expose the model key to the agent process; see [security](security.md) for the distinction.
