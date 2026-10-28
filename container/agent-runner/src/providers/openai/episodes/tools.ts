/**
 * Escape-hatch topic tools for the main agent.
 *
 * The automatic decision is right most of the time; these exist for the times
 * it is not ("actually, let's park this and start something else"). They record
 * an intent rather than switching mid-turn: an in-flight turn owns its history
 * (tool calls must be answered in the same message list), so the switch is
 * applied once the reply is saved and takes effect from the next message.
 */
import type { OpenAITool } from '../tools/builtin.js';
import { DEFAULT_EMOJI, relativeWhen, sanitizeEmoji, sanitizeTitle } from './format.js';
import { readEpisodes, type Episode } from './ledger.js';
import { callReadTopic, READ_TOPIC, readTopicSchema, renderTopicList } from './read.js';

export const START_NEW_TOPIC = 'start_new_topic';
export const RESUME_TOPIC = 'resume_topic';

export type PendingTopicAction =
  | { kind: 'new'; title: string; emoji: string }
  | { kind: 'resume'; episodeId: string };

const startNewTopicSchema: OpenAITool = {
  type: 'function',
  function: {
    name: START_NEW_TOPIC,
    description:
      'Park the current topic and start a fresh one. Only when the user is clearly moving on and' +
      ' the automatic switch did not fire. The current topic is archived and summarized, not lost.' +
      ' Takes effect from the next message.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the new topic, e.g. "Blackwater Bay trip".' },
        emoji: { type: 'string', description: 'One emoji for the new topic.' },
      },
      required: ['title'],
    },
  },
};

const resumeTopicSchema: OpenAITool = {
  type: 'function',
  function: {
    name: RESUME_TOPIC,
    description:
      'Pick a past topic from <recent-conversations> back up, restoring its history. Use when the' +
      ' conversation is really moving back to it — if you only need to know what was said, use' +
      ' read_topic instead and stay where you are. Takes effect from the next message; this call' +
      ' returns the summary so you can bridge right away.',
    parameters: {
      type: 'object',
      properties: {
        episode_id: { type: 'string', description: 'Topic id from <recent-conversations>, e.g. "ep_6c11".' },
      },
      required: ['episode_id'],
    },
  },
};

export function episodeToolSchemas(): OpenAITool[] {
  return [startNewTopicSchema, resumeTopicSchema, readTopicSchema];
}

export function isEpisodeTool(name: string): boolean {
  return name === START_NEW_TOPIC || name === RESUME_TOPIC || name === READ_TOPIC;
}

function describe(episode: Episode): string {
  const parts = [`${episode.emoji} ${episode.title} (last active ${relativeWhen(episode.lastActiveAt)})`];
  if (episode.summary) parts.push(episode.summary);
  if (episode.conversationPage) parts.push(`Page: ${episode.conversationPage}`);
  return parts.join('\n');
}

/**
 * Validate the call and return the intent for the provider to apply after the
 * turn. `action` is null when the call cannot be honoured.
 */
export async function callEpisodeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; action: PendingTopicAction | null }> {
  // Read-only, so it never produces an action — the whole point is that
  // looking at a parked topic leaves the ledger where it is.
  if (name === READ_TOPIC) return { text: await callReadTopic(args), action: null };

  if (name === START_NEW_TOPIC) {
    const title = sanitizeTitle(args.title, '');
    if (!title) return { text: 'Error: title is required.', action: null };
    const emoji = sanitizeEmoji(args.emoji, DEFAULT_EMOJI);
    return {
      text:
        `Starting a new topic "${emoji} ${title}" after this reply. Finish answering on the current` +
        ' context; the next message begins fresh.',
      action: { kind: 'new', title, emoji },
    };
  }

  if (name === RESUME_TOPIC) {
    const episodeId = typeof args.episode_id === 'string' ? args.episode_id.trim() : '';
    if (!episodeId) return { text: 'Error: episode_id is required.', action: null };
    const episodes = await readEpisodes();
    const target = episodes.find((e) => e.id === episodeId);
    if (!target) {
      return {
        text: `No topic with id "${episodeId}".\n\nKnown topics:\n${renderTopicList(episodes)}`,
        action: null,
      };
    }
    if (target.id === episodes[episodes.length - 1]?.id) {
      return { text: `"${target.title}" is already the current topic.`, action: null };
    }
    return {
      text: `Resuming this topic from the next message onward:\n${describe(target)}`,
      action: { kind: 'resume', episodeId: target.id },
    };
  }

  return { text: `Unknown tool: ${name}`, action: null };
}
