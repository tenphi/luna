import type { EmailConfigDoc } from './schema.js';

/**
 * What the agent may do with mail out of the box.
 *
 * Reading is unrestricted; writing stops at a draft. `create_draft` is in the default set and
 * `send_mail` is not, because a draft is reviewable — it lands in Gmail's own drafts folder where
 * a person sees it before anything leaves — while a send is not reversible by anyone.
 *
 * `save_attachment` is a read tool despite writing a file: it writes only into the calling
 * session's own workspace, which the agent can already write to.
 */
export const EMAIL_DEFAULT_TOOLS_ALLOW = [
  'list_mailboxes',
  'search_mail',
  'read_thread',
  'read_message',
  'list_attachments',
  'read_attachment',
  'save_attachment',
  'create_draft',
  'mark_read',
] as const;

/** How much of one message body reaches the agent before it is truncated with a continuation. */
export const EMAIL_DEFAULT_MAX_BODY_CHARS = 4000;

/** Product defaults for the email builtin (mirrors config/default.jsonc). */
export const DEFAULT_EMAIL_DOC: EmailConfigDoc = {
  enabled: false,
  backend: 'gmail-imap',
  toolsAllow: [...EMAIL_DEFAULT_TOOLS_ALLOW],
  maxBodyChars: EMAIL_DEFAULT_MAX_BODY_CHARS,
};
