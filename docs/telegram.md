---
title: Telegram and shared use
---

# Telegram and shared use

Luna is primarily a Telegram assistant hosted on your Mac. You create the bot, choose who can talk to her, and connect the services she can use. People can message the same bot from any device; they do not need to install Luna themselves.

One installation can serve several trusted users, in individual conversations and Telegram groups. With Akno connected, they share one knowledge base. Luna recognizes configured people and uses their profile context alongside shared knowledge.

## Connect your bot

Run `luna setup` and choose Telegram when the wizard asks how you want to chat. It guides you through:

1. Creating a bot with Telegram's official `@BotFather` and entering its token.
2. Choosing the owner and adding the other people who may use Luna.
3. Pairing the owner with a code sent to the bot.
4. Receiving a welcome message and starting a conversation.

Keep the bot token in the private install. Each person should use the Telegram username entered in the roster. People outside the roster are refused.

## Add another person

From the host terminal, using these invented names as examples:

```bash
luna config users set --key bo --name "Bo Winters" --telegram-handle bo_winters
luna redeploy --no-build
```

They can then message the bot. The stable `bo` key identifies the person even if their Telegram handle later changes. For an account without a public username, use the host's `luna users bind` command after their identity appears; `luna users bind --help` explains its flags.

To stop answering someone while retaining their entry:

```bash
luna config users set --key bo --enabled false
luna redeploy --no-build
```

## Use a shared group

Add the bot to a Telegram group whose participants are in Luna's roster. If the bot needs to receive ordinary group messages, follow the setup guidance for `@BotFather` → Bot Settings → Group Privacy. Then address the bot in the group and let the owner approve connecting that chat when Luna requests it. Groups normally engage when the bot is mentioned; their conversation context is separate from direct messages.

Use a group for shared plans, decisions, and reminders that everyone should see. Direct messages remain separate conversations, while Akno can supply the common knowledge behind them.

## Share the Mac services too

Apple integrations use the accounts signed in on the hosting Mac. Choose calendars, reminder lists, and Notes folders shared with the people using Luna. For example, configure a `Shared` calendar and `Shared` reminder list using [Apple setup](apple-services.md). Contacts use the host's granted address-book access.

Luna does not sign in to each Telegram user's Apple account or automatically switch Mac accounts when a different person speaks. The configured Apple calendar and reminder list apply to the whole installation.

## A shared trust domain

The Akno folder is shared knowledge, including information learned from eligible conversations. Per-person profiles and separate chat sessions help organize context; they are not an access-control boundary for that knowledge. Use separate Luna and Akno installations when people require independent privacy. See [security](security.md).
