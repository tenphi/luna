/**
 * Composing outgoing mail, and the two ways it can leave.
 *
 * **A draft is the default and a send is the exception**, which is why drafting is the cheaper path
 * here as well as the safer one: `MailComposer` builds the MIME and IMAP `APPEND` puts it in the
 * person's own Drafts folder. No SMTP, nothing delivered, and a human opens Gmail and presses send.
 * For an assistant writing on someone's behalf that is almost always the right shape — the mistake
 * a draft makes is visible and free, the mistake a send makes is neither.
 *
 * Sending goes over SMTP with the same app password. Gmail also files a copy in Sent by itself for
 * SMTP submissions, so nothing appends a second copy — doing that is how mail ends up duplicated in
 * Sent.
 */
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

import { log } from '../../../../../log.js';
import type { Mailbox, OutgoingMail } from '../types.js';
import { withConnection } from './client.js';

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;

/** Gmail refuses messages past 25 MB; failing here beats failing after the upload. */
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function fromHeader(mailbox: Mailbox): string {
  return mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address;
}

interface Attachment {
  filename: string;
  content: Buffer;
}

function loadAttachments(paths: string[] | undefined): Attachment[] {
  if (!paths || paths.length === 0) return [];

  const loaded: Attachment[] = [];
  let total = 0;
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) throw new Error(`No file to attach at ${path.basename(filePath)}`);
    const content = fs.readFileSync(filePath);
    total += content.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments total more than ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB, which Gmail will reject. ` +
          `Send fewer or smaller files, or share a link instead.`,
      );
    }
    loaded.push({ filename: path.basename(filePath), content });
  }
  return loaded;
}

/**
 * Build the RFC-822 message.
 *
 * `inReplyTo` and `references` are what actually make Gmail thread a reply. Gmail will also thread
 * on a matching subject, which is why it is easy to believe this works when it does not: the reply
 * lands in the right conversation for the sender and in a new one for everybody else's client.
 */
async function compose(mailbox: Mailbox, mail: OutgoingMail): Promise<Buffer> {
  const attachments = loadAttachments(mail.attachmentPaths);

  const composer = new MailComposer({
    from: fromHeader(mailbox),
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    text: mail.body,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo.messageId, references: mail.inReplyTo.references.join(' ') } : {}),
  });

  return composer.compile().build();
}

/** Gmail's Drafts folder, by special-use flag — the name is localized per account. */
async function findDrafts(client: Parameters<Parameters<typeof withConnection>[1]>[0]): Promise<string> {
  const boxes = await client.list();
  const byFlag = boxes.find((b) => b.specialUse === '\\Drafts');
  if (byFlag) return byFlag.path;
  const byName = boxes.find((b) => b.path === '[Gmail]/Drafts');
  if (byName) return byName.path;
  throw new Error('This account has no Drafts folder visible over IMAP (Gmail: Settings → Labels → show in IMAP).');
}

export async function appendDraft(mailbox: Mailbox, mail: OutgoingMail): Promise<{ webUrl: string }> {
  const raw = await compose(mailbox, mail);

  return withConnection(mailbox, async (client) => {
    const drafts = await findDrafts(client);
    const appended = await client.append(drafts, raw, ['\\Draft']);
    if (!appended) throw new Error('Gmail refused the draft');
    log.info('mail draft created', { mailbox: mailbox.key, to: mail.to.length });
    return { webUrl: 'https://mail.google.com/mail/u/0/#drafts' };
  });
}

export async function sendMail(mailbox: Mailbox, mail: OutgoingMail): Promise<{ messageId: string }> {
  const raw = await compose(mailbox, mail);

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: mailbox.address, pass: mailbox.appPassword },
  });

  try {
    const result = await transport.sendMail({
      envelope: { from: mailbox.address, to: [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])] },
      raw,
    });
    log.info('mail sent', { mailbox: mailbox.key, messageId: result.messageId });
    return { messageId: result.messageId };
  } finally {
    transport.close();
  }
}
