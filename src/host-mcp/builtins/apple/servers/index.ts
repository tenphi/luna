import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AppleAppConfig, AppleAppId } from '../shared/types.js';
import { createCalendarMcpServer } from './calendar.js';
import { createContactsMcpServer } from './contacts.js';
import { createMessagesMcpServer } from './messages.js';
import { createNotesMcpServer } from './notes.js';
import { createRemindersMcpServer } from './reminders.js';

/** Build the in-process MCP server for a given Apple app. */
export function createAppleServer(app: AppleAppId, config: AppleAppConfig): McpServer {
  switch (app) {
    case 'calendar':
      return createCalendarMcpServer(config);
    case 'reminders':
      return createRemindersMcpServer(config);
    case 'notes':
      return createNotesMcpServer(config);
    case 'contacts':
      return createContactsMcpServer(config);
    case 'messages':
      return createMessagesMcpServer(config);
    default: {
      const exhaustive: never = app;
      throw new Error(`Unknown Apple app: ${String(exhaustive)}`);
    }
  }
}
