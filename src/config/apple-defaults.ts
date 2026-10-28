import type { AppleConfigDoc } from './schema.js';

/** Product defaults for the Apple apps builtin (mirrors config/default.jsonc). */
export const DEFAULT_APPLE_DOC: AppleConfigDoc = {
  enabled: true,
  apps: {
    calendar: { enabled: true, defaultCalendar: 'Home', safetyMode: 'normal' },
    reminders: { enabled: true, defaultList: 'Reminders', safetyMode: 'normal' },
    notes: { enabled: true, defaultFolder: null, safetyMode: 'normal' },
    contacts: { enabled: true, safetyMode: 'normal' },
    messages: { enabled: false, safetyMode: 'normal' },
  },
};
