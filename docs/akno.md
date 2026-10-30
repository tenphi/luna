---
title: Akno integration
---

# Akno integration

[Akno](https://akno.tenphi.me) gives Luna durable knowledge over a Markdown folder you own. It is recommended, optional, and installed as a separate product.

One Luna installation connects its users to the same Akno knowledge base. Luna keeps per-person profile context while recalling and maintaining shared information. This suits a household or another trusted group; separate conversations and profile pages do not provide private knowledge stores for each person.

## Install it independently

```bash
npm install -g @tenphi/akno
akno init
```

Follow [Akno's setup flow](https://akno.tenphi.me/getting-started) for its models, credentials, knowledge folder, write policies, index, service, and maintenance schedule. The OpenAI minimum preset uses `gpt-6-luna` and `text-embedding-3-small`. Luna's setup does not reproduce that flow.

Once the service is ready:

```bash
akno doctor
luna config memory set --enabled true
luna redeploy --no-build
luna health
```

The default socket is `~/.akno/akno.sock`. Configure a custom one with `luna config memory set --socket /path/to/akno.sock`.

## What Luna adds

- Automatic recall before substantive user turns, with selected evidence rather than an unbounded dump of notes.
- Explicit memory tools for reading, writing, and editing knowledge.
- Optional learning after direct conversations. The credential guard excludes messages that look like secrets.
- Conversation summaries and source-aware references.
- Context for external edits to pages the session has watched, so a correction made in your editor can be acknowledged.

The knowledge folder is never mounted into the agent container. Luna calls Akno on the host and relays its tools. Akno controls extraction, embeddings, routing, provenance, write policies, undo, and nightly maintenance.

## Control the integration

```bash
luna config memory get
luna config memory set --auto-recall false
luna config memory set --digest false
luna config memory set --enabled false
```

Disabling automatic recall leaves explicit tools available. Disabling digest stops background conversation learning. Disabling memory removes the integration; ordinary chat, Apple tools, and email still work.

An unavailable service is reported as unavailable evidence. Luna must not interpret a timeout as proof that your knowledge contains nothing about the question. Troubleshoot Akno with its own `akno doctor` and `akno dream status`; Luna does not repair or resume Akno maintenance.

When Akno answers a call on its fallback provider, for example the API key when its ChatGPT subscription has hit a usage limit, the result carries a `model_fallback` warning. Luna passes the warning to the agent, including from automatic recall, and the agent mentions it in its reply. The answer itself is unaffected. Akno's [configuration guide](https://akno.tenphi.me/configuration) explains when it falls back.
