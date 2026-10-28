# Luna

A personal assistant becomes useful when she has context about your life. Luna connects to your services and, with Akno, remembers important details and previous conversations. She can pick up a subject, respond to your specific needs, and help maintain the knowledge you build together.

Luna runs on your Mac and talks to you through your own Telegram bot. Several trusted people can use her in direct messages and groups, sharing one Akno knowledge base. A terminal chat is also available.

[Documentation](https://luna.tenphi.me) · [Getting started](docs/getting-started.md) · [Security](docs/security.md)

## Why Luna

- **Built for macOS.** Calendar and Reminders use EventKit; Notes and Contacts use AppleScript. Apple permissions belong to the host app, while agent tools run in a separate Linux VM.
- **One bot for your people.** Use Telegram on any device, with individual conversations and shared groups. One installation can serve several configured users and one shared knowledge base. Use shared calendars and reminder lists for Mac services.
- **Useful email access.** Search Gmail threads, read attachments, and create drafts. Sending is an explicit opt-in.
- **Natural conversation.** Change subjects without clearing your chat. Luna parks earlier topics and can return to their history when you refer back to them.
- **Isolated tools.** Each session gets its own agent container, a working folder, and the capabilities you grant. The browser, shell, and document tools run there.
- **Knowledge you can edit.** Optional [Akno](https://akno.tenphi.me) integration adds recall, learning, and Markdown knowledge you can inspect and correct in your editor. Luna notices external edits to watched pages.
- **Your model endpoint.** Start with OpenAI `gpt-6-luna`, or configure another OpenAI-compatible endpoint.

## Get started

You need an Apple silicon Mac with macOS 26 or newer, Node 22.22 or newer, pnpm, and [Apple Container](https://github.com/apple/container/releases). Start Apple Container with `container system start`.

After the first npm release:

```bash
npm install -g @tenphi/luna
luna setup
luna
```

Until that release, use the [source installation](docs/getting-started.md#from-source). Setup starts with `https://api.openai.com/v1` and `gpt-6-luna`. It guides you through credentials, the sandbox, the background service, and optional Telegram. Install files and private state live in `~/.luna`; set `LUNA_HOME` to choose another directory.

**Recommended:** install Akno using [its own setup flow](https://akno.tenphi.me/getting-started), choosing the OpenAI preset (`gpt-6-luna` and `text-embedding-3-small`). Then connect it in Luna setup. You can also start without Akno and add it later. Luna does not configure Akno's models or manage its service.

## Try it

```bash
luna ask "What can you help me with?"
luna health
luna setup step apple
luna setup step email
```

Once you grant access, ask things like “What is on our shared calendar tomorrow?”, “Draft a reply to this email”, or “Remember that I prefer morning meetings”. The last request needs Akno. See [everyday use](docs/everyday-use.md) and [Telegram and shared use](docs/telegram.md).

## Boundaries

Luna is in active pre-1.0 development. Conversation state stays on your Mac, but the configured model provider receives the messages and tool results used to answer. Enabled integrations can read or change your data; choose their permissions deliberately. See [security](docs/security.md) and [isolation](docs/isolation-model.md).

## Development

```bash
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
pnpm build
pnpm test
pnpm test:container
```

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture](docs/architecture.md).

## License

Source-available under [PolyForm Noncommercial 1.0.0](LICENSE). Personal and other noncommercial use is permitted. Commercial use requires a separate license. Third-party components retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
