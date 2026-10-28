/** Non-secret install keys that belong in config/local.jsonc, not `.env`. */
export const ENV_LOCAL_KEYS = [
  'ASSISTANT_NAME',
  'TZ',
  'LUNA_DEFAULT_PROVIDER',
  'LUNA_DEFAULT_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'LUNA_APPLE_DEFAULT_CALENDAR',
  'LUNA_APPLE_DEFAULT_REMINDERS_LIST',
  'LUNA_APPLE_DEFAULT_NOTES_FOLDER',
] as const;

/**
 * Same as ENV_LOCAL_KEYS plus keys setup may still find in an existing `.env`.
 *
 * `LUNA_MEMORY_PATH` is deliberately *not* on this list. Setup never writes it, so stripping it
 * would only fight an operator who set it by hand to point the filesystem-backed memory tools at a
 * knowledge base for local debugging.
 */
export const SETUP_STRIP_ENV_KEYS = [...ENV_LOCAL_KEYS, 'ONECLI_URL'] as const;
