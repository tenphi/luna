---
title: Getting started
---

# Getting started

This guide takes a fresh Mac to a first conversation with your Telegram bot. One Mac can host Luna for several trusted users. Akno adds a shared knowledge base; email and Apple services can be added afterward. You can also start with terminal chat alone.

## Requirements

- An Apple silicon Mac running macOS 26 or newer. Luna's host is macOS-only.
- Node 22.22 or newer and pnpm 10.33.0. The repository's `packageManager` pins pnpm.
- [Apple Container](https://github.com/apple/container/releases), installed through its signed installer.
- An OpenAI API key with access to `gpt-6-luna`, or another OpenAI-compatible endpoint.

Source installations also need [Bun](https://bun.sh/) 1.3.12 or newer to install the agent-runner dependencies. The npm installation uses Bun inside its container image.

Start the container service:

```bash
container system start
```

The first agent image build downloads its tools and can take several minutes. Leave the setup terminal open. If npm needs to compile SQLite and reports a missing compiler, install the Xcode command line tools with `xcode-select --install`, then retry.

## Install Luna

```bash
npm install -g @tenphi/luna
luna setup
```

The package creates a private install directory at `~/.luna`. Configuration, credentials, logs, and conversations are kept there, separately from the npm package. To choose a different location, set `LUNA_HOME` consistently for every invocation.

The standard wizard guides you through:

1. Checking the Mac and building the agent sandbox.
2. Connecting or installing the OneCLI credential gateway.
3. Entering an OpenAI key. The endpoint defaults to `https://api.openai.com/v1`, the model to `gpt-6-luna`.
4. Connecting an existing Akno service, or continuing without memory.
5. Installing the Luna background service and terminal agent.
6. Creating or connecting your Telegram bot, pairing the owner, and adding other people to the roster. Telegram is recommended; you can skip it for a terminal-only start.

Use Advanced to choose a different endpoint or model. A local endpoint may be keyless. Credentials go into the private `.env`, while settings go into `config/local.jsonc`. Setup diagnostics stay on your Mac.

## Recommended knowledge setup

Install Akno independently:

```bash
npm install -g @tenphi/akno
akno init
```

Follow [Akno's getting-started guide](https://akno.tenphi.me/getting-started). Choose its OpenAI minimum preset for `gpt-6-luna` and `text-embedding-3-small`, and configure the Markdown folder and write boundaries there. Finish its service setup; `akno doctor` should report a usable service.

Then connect from Luna setup, or later:

```bash
luna config memory set --enabled true
luna redeploy --no-build
luna health
```

Luna uses Akno's default socket at `~/.akno/akno.sock`. A custom path can be set with `luna config memory set --socket /path/to/akno.sock`. See [Akno integration](akno.md).

## First conversation

Message your bot in Telegram. Setup sends a welcome message after pairing; the other people in your roster can message the same bot. See [Telegram and shared use](telegram.md) for groups and adding people later.

For a terminal conversation:

```bash
luna
```

Or send a single prompt:

```bash
luna ask "Introduce yourself and explain which tools are available."
```

A one-shot request uses an ephemeral session. The interactive chat keeps conversation history. Run `luna health` to inspect the model, sandbox, memory, and enabled services.

## Add services when you need them

```bash
luna setup step apple
luna setup step email
```

Follow the guides for [Apple services](apple-services.md) and [email](email.md). Telegram is offered by the wizard; only the people in your configured roster are admitted.

## From source

Before the first npm release, or for development:

```bash
git clone https://github.com/tenphi/luna.git
cd luna
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
./bin/luna setup
```

Source installs keep state in the checkout. Do not copy it into another repository or add its private folders to Git. See [operations](guides.md) if setup stops partway through.
