export type AppleAppId = 'calendar' | 'reminders' | 'notes' | 'messages' | 'contacts';

/** Safety mode gating for the in-process Apple MCP servers. */
export type AppleSafetyMode = 'normal' | 'read-only' | 'confirm-destructive';

export interface AppleAppConfig {
  enabled: boolean;
  /** Default: normal (all tools, no confirm gate). */
  safetyMode?: AppleSafetyMode;
  defaultCalendar?: string | null;
  defaultList?: string | null;
  defaultFolder?: string | null;
}

export interface AppleConfig {
  enabled: boolean;
  apps: Record<AppleAppId, AppleAppConfig>;
}

export const APPLE_APP_ORDER: AppleAppId[] = ['calendar', 'reminders', 'notes', 'contacts', 'messages'];

export const APPLE_SERVER_KEYS = {
  calendar: 'apple_calendar',
  reminders: 'apple_reminders',
  notes: 'apple_notes',
  messages: 'apple_messages',
  contacts: 'apple_contacts',
} as const satisfies Record<AppleAppId, string>;
