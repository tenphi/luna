# Documentation

Start with [getting started](getting-started.md) and [everyday use](everyday-use.md).

| Guide                                  | Purpose                                                     |
| -------------------------------------- | ----------------------------------------------------------- |
| [Telegram and shared use](telegram.md) | Your bot, people, groups, and one shared knowledge base     |
| [Apple services](apple-services.md)    | Calendar, Reminders, Notes, Contacts, and optional Messages |
| [Email](email.md)                      | Gmail threads, attachments, drafts, and exclusions          |
| [Akno](akno.md)                        | Optional durable knowledge and its separate setup           |
| [Configuration](configuration.md)      | Defaults, private overlay, users, and credentials           |
| [Commands](api.md)                     | Common CLI actions and advanced help                        |
| [Operations](guides.md)                | Setup recovery, upgrades, logs, and development checks      |
| [Security](security.md)                | Trust, permissions, data flow, and release hygiene          |
| [Architecture](architecture.md)        | Message flow and code ownership                             |
| [Isolation](isolation-model.md)        | Session and install boundaries                              |
| [Release preparation](releasing.md)    | Gates, privacy scans, npm, and documentation hosting        |

The website is built by [Cookbook](https://www.npmjs.com/package/@tenphi/cookbook). Its configuration is in `docs.config.ts`; `pnpm docs:doctor` checks it before `pnpm docs:build` writes `site-dist/`.
