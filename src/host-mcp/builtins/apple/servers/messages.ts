/**
 * In-process Apple Messages MCP server.
 *
 * Reads (chats/messages/search/participants) go through the read-only SQLite
 * store (`messages-db.ts`); sending goes through AppleScript.
 *
 * Derived from MIT-licensed griches/apple-mcp (`@griches/apple-messages-mcp` 1.0.0),
 * vendored in-tree by Luna. Raw tool names preserved for the tool-alias map.
 *
 * Safety: under `read-only`, `send_message` is not registered (Luna improvement
 * over griches, which ignored safety flags for Messages).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';

import { errorResult, textResult } from '../../shared/cli.js';
import { runAppleScript, sanitize } from '../shared/applescript.js';
import { isReadOnly } from '../shared/safety.js';
import type { AppleAppConfig } from '../shared/types.js';
import { getChatMessages, getChatParticipants, listChats, searchMessages } from './messages-db.js';

async function sendMessage(to: string, text: string, service: 'iMessage' | 'SMS' = 'iMessage'): Promise<string> {
  const safeTo = sanitize(to);
  const safeText = sanitize(text);
  const serviceType = service === 'SMS' ? 'SMS' : 'iMessage';
  return runAppleScript(`
tell application "Messages"
  set targetService to 1st service whose service type = ${serviceType}
  set targetBuddy to buddy "${safeTo}" of targetService
  send "${safeText}" to targetBuddy
end tell
return "Message sent to ${safeTo}"`);
}

export function createMessagesMcpServer(config: AppleAppConfig): McpServer {
  const mode = config.safetyMode;
  const server = new McpServer({ name: 'apple-messages', version: '1.0.0' }, { capabilities: {} });

  server.registerTool(
    'list_chats',
    {
      description: 'List recent chats with last message preview and participant info',
      inputSchema: { limit: z.number().optional().describe('Maximum number of chats to return (default 50)') },
    },
    async ({ limit }) => {
      try {
        return textResult(listChats(limit));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_chat_messages',
    {
      description: 'Get message history for a specific chat',
      inputSchema: {
        chat_id: z.string().describe('Chat identifier (e.g. iMessage;-;+1234567890)'),
        limit: z.number().optional().describe('Maximum number of messages to return (default 100)'),
        from_date: z
          .string()
          .optional()
          .describe("Filter messages from this date (e.g. '2025-01-01' or '2025-03-15T14:00:00')"),
        to_date: z.string().optional().describe("Filter messages up to this date (e.g. '2025-12-31')"),
      },
    },
    async ({ chat_id, limit, from_date, to_date }) => {
      try {
        return textResult(getChatMessages(chat_id, limit, from_date, to_date));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'search_messages',
    {
      description: 'Search messages by text content',
      inputSchema: {
        query: z.string().describe('Text to search for in messages'),
        chat_id: z.string().optional().describe('Limit search to a specific chat'),
        limit: z.number().optional().describe('Maximum number of results (default 50)'),
      },
    },
    async ({ query, chat_id, limit }) => {
      try {
        return textResult(searchMessages(query, chat_id, limit));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  if (!isReadOnly(mode)) {
    server.registerTool(
      'send_message',
      {
        description: 'Send an iMessage or SMS to a phone number or email address',
        inputSchema: {
          to: z.string().describe('Phone number or email address of the recipient'),
          text: z.string().describe('Message text to send'),
          service: z.enum(['iMessage', 'SMS']).optional().describe('Service to use (default iMessage)'),
        },
      },
      async ({ to, text, service }) => {
        try {
          return textResult(await sendMessage(to, text, service));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  server.registerTool(
    'get_chat_participants',
    {
      description: 'Get participants of a chat',
      inputSchema: { chat_id: z.string().describe('Chat identifier (e.g. iMessage;-;+1234567890)') },
    },
    async ({ chat_id }) => {
      try {
        return textResult(getChatParticipants(chat_id));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
