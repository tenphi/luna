---
title: Security
---

# Security

Luna trusts the Mac and its host process. Incoming messages, attachments, recalled knowledge, model output, and container tool commands are untrusted inputs.

## Host and agent boundary

Each agent session runs in a Linux VM through Apple Container. The container sees its agent working folder, shipped runtime code, and explicitly granted mounts. It does not get general home-directory access, the central database, or an automatic mount of the Akno knowledge folder.

Apple and email tools execute on the host and are exposed through a session-authenticated MCP bridge. Calendar and Reminders use the Luna app wrapper's EventKit permissions; Notes and Contacts use Automation permissions. Granting a host integration adds real capabilities and can expose its results to the configured model.

Every session has one host-owned `session.db`. Containers access it through the authenticated Session API rather than opening SQLite files. The host enforces destination and command permissions against its own state. A container's view of a destination is not final authority to deliver there.

## Identity

People are declared in the private `users` roster. Channel identities bind to those entries; unknown senders are refused. The configured owner has privileged actions. The terminal socket is mode `0600`, and host access is its credential.

Roster edits and approving pending actions are host-only operations. A shared install is a shared trust domain: default mailboxes, session separation, and memory profiles do not provide complete isolation between people. Use separate installs for independent trust domains.

## Credentials

The install's `.env` is plaintext private state. The setup logger redacts secret values. No telemetry is sent by Luna setup.

OneCLI can store API credentials, inject them into approved outbound requests, and apply gateway policies. Its agent secret assignments and approval policies must be configured correctly; a configured vault alone does not mean every action is approval-gated.

Luna also supports a directly configured model API key. That key is passed to the model client in the agent process. Container isolation therefore does not imply that a direct model key is hidden from agent code. Use a restricted project key and the gateway's credential flow where appropriate. Host email credentials stay in the host integration.

## Actions and approvals

Apple apps support `normal`, `read-only`, and `confirm-destructive` modes. `normal` permits registered actions without adding an approval to every edit. Email defaults to reading, drafts, and marking read; sending and archiving require opt-in tools. Package and MCP configuration changes from the agent use the owner approval path.

Only mount folders needed for a task. Never mount key stores, vault directories, browser profiles, or the whole home directory as a convenience. Prompt injection can arrive in a page, attachment, email, or website; tool allowlists and action policies remain necessary even when the assistant usually follows instructions.

## Data leaving the Mac

Hosted model calls include the conversation and tool results needed for the answer. An OpenAI-configured Akno service can send knowledge inputs for embedding and generation. Telegram receives messages delivered through its channel. Browser and other network tools contact the services they use. Local state does not mean that all processing is local.

Logs, reports, traces, mail caches, attachments, conversation databases, and Markdown knowledge can contain personal data. They are never release assets. Review and redact diagnostic material before sharing it.

## Repository and release checks

`pnpm check:repository` checks tracked and new public files for local state, credential shapes, home paths, and unexpected email addresses. A private JSON identifier list can be supplied through `LUNA_PRIVACY_TERMS_FILE`; values are never printed. `pnpm check:history` scans all reachable commit, tag, and blob objects, including commit metadata.

CI adds Gitleaks and checks the installed npm tarball. Automated scans cannot prove that arbitrary prose contains no private information; release review also checks fixtures, comments, documents, and binary assets. See [release preparation](releasing.md).

For a vulnerability, use the repository's private GitHub security reporting when available. Do not put credentials or personal reproduction data into a public issue.
