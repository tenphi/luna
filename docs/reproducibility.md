---
title: Agent behavior
---

# Agent behavior

Luna's behavior comes from its model, repository instructions, enabled tools, and the context available to a particular installation. A fresh OpenAI setup gets the same shipped workflows. Personal knowledge and private integrations need their own setup.

## What ships

| Layer                | Repository source                                                      | Purpose                                                                                       |
| -------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Core behavior        | `container/AGENTS.md`                                                  | Persona, source-backed answers, narrow verified updates, reporting, and skill use             |
| Integration guidance | `container/fragments/` and MCP `*.instructions.md`                     | Knowledge, topics, tools, reminders, and delivery contracts                                   |
| Skills               | `container/skills/<name>/SKILL.md`                                     | Workflows loaded on demand through the `Skill` tool                                           |
| Prompt assembly      | `src/agents-md-compose.ts` and the OpenAI provider's `instructions.ts` | Compose enabled imports, flatten them into the system prompt, and advertise the skill catalog |
| Model defaults       | `config/default.jsonc`                                                 | OpenAI Responses, `gpt-6-luna`, and `effort: "adaptive"`                                      |

Product research, webshop checks, and person-profile maintenance are included as general workflows. They assume no particular household, employer, country, spending pattern, or knowledge-folder layout. Reporting guidance keeps the reporting period separate from the run date, uses normalized tool totals, and discloses incomplete coverage.

The OpenAI provider includes the actual instructions and skill catalog in API requests; these are not features supplied automatically by the endpoint. The main agent uses the Responses API so `gpt-6-luna` can reason while using function tools. Luna preserves the original output items, encrypted reasoning state, and assistant phases through tool calls and resumed sessions, with `store: false`. See the [official model reference](https://developers.openai.com/api/docs/models/gpt-6-luna) and [reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context).

## Thinking without a slow router

`agent.effort: "adaptive"` selects `low`, `medium`, or `high` once per main agent turn through Decisions. The selector receives at most 4,000 characters from the latest message, 600 from the preceding assistant reply, and attachment, scheduled-task, and truncation flags. It receives no full system instructions, skill bodies, retrieved memory, tool results, or entire transcript. The previous reply is a bounded continuity hint; the main agent still receives its normal context.

The selector has a one-second deadline, no retry, and a `medium` fallback for uncertainty, invalid results, outages, unsupported models, or unavailable Decisions. It never selects `none` and never changes permissions. Simple requests can use `low`; ordinary research and planning use `medium`; complex analysis, conflicting evidence, and consequential work can use `high`. Missing context should keep at least medium effort. All tool rounds within that turn retain the selected effort. The completed tool status reports it, for example `Done in 12s · reasoning: high`, without exposing reasoning text.

For a fixed budget, set `agent.effort` to `low`, `medium`, `high`, `xhigh`, or `max` supported by your model. `none` remains an explicit opt-in. Compatible endpoints can select `providers.<name>.api: "chat-completions"`; OpenAI's `gpt-6-luna` Chat Completions route requires `none` with function tools, so use Responses for its thinking agent. Adaptive routing uses `gpt-6-luna`; other models fall back to medium without a Decisions call.

## What belongs to an installation

`agent/AGENTS.local.md`, authored `agent/skills/`, private configuration, user profiles, conversation state, and Akno knowledge are excluded from the repository and npm package. So are private domain workflows such as a household budgeting routine. Extract useful general rules using invented examples; do not distribute personal thresholds, payees, balances, or document contents.

Built-in skills take precedence over an authored skill with the same name. An installation with customized product or profile workflows should review the shipped versions before upgrading. Authored files are preserved; changing the active selection requires the install's normal configuration and redeploy flow.

Without Akno, Luna can use the current conversation and connected tools. It cannot reproduce answers that depend on an existing knowledge base or claim to save durable knowledge. With Akno, results also depend on its models, source documents, retrieval state, and write policies. Apple services, email, Telegram routing, and permissions need separate integration verification.

## Repeat the OpenAI check

From a source checkout with the host and agent dependencies installed:

```bash
pnpm eval:public-agent --runs 3
```

Provide a real `OPENAI_API_KEY` in the environment or private `.env` file. `LUNA_EVAL_API_KEY` can override it for this check. This command makes billable requests to `https://api.openai.com/v1` using `gpt-6-luna`; it does not run in CI. It deliberately ignores the installation's model overrides, OneCLI agent, local instructions, authored skills, and knowledge base.

The check runs source-grounded calendar updates, complete reference capture, scheduled email digests, topic boundaries, skill discovery/loading, profile edits, product and seller research, and report totals. All services and source records are synthetic. The digest tests exercise the real delivery guard against a mocked Session API; no message is delivered to a real recipient.

Results go to ignored `output/public-agent-eval/`. They record scenario outcomes, instruction and skill hashes, elapsed time, tool-call counts, and Responses token usage, including reasoning tokens, and the effort used on each request when returned. Adaptive effort cases test easy, complex, ambiguous, and adversarial routing inputs. Topic cases include the production Decisions route and deterministic reply/follow-up handling. Its two-second deadline is unchanged. Use `--family source-grounding` or another family name to narrow a run; `--runs` accepts one to five repeats.

Repeated passes establish observed behavior on these cases, not identical text or a guarantee for every task. API changes, model aliases, network latency, source quality, and integration state can change results. Inspect failures and preserve the original results; do not substitute another model or weaken a source requirement to make the report pass.
