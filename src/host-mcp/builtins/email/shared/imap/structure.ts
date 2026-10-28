/**
 * Reading a message's shape without reading the message.
 *
 * `BODYSTRUCTURE` describes every MIME part — type, size, disposition, and the part number needed
 * to fetch it — without transferring any content. That is what lets `read_message` on a mail with a
 * 12 MB deck attached cost only the few kilobytes of text the agent actually needs, and lets
 * `list_attachments` answer entirely from metadata.
 */
import type { MessageStructureObject } from 'imapflow';

import type { AttachmentMeta } from '../types.js';

export interface BodyPartChoice {
  /** MIME part number for the fetch, e.g. `1.1`. Null when the message is a single unstructured part. */
  part: string | null;
  type: 'text/plain' | 'text/html';
  encoding: string;
  charset: string;
}

function charsetOf(node: MessageStructureObject): string {
  return node.parameters?.charset?.toLowerCase() ?? 'utf-8';
}

function isAttachmentNode(node: MessageStructureObject): boolean {
  const disposition = node.disposition?.toLowerCase();
  if (disposition === 'attachment') return true;
  // Inline images with filenames are attachments for our purposes: they are not readable prose and
  // the agent may still want to extract text from them.
  return Boolean(node.dispositionParameters?.filename || node.parameters?.name);
}

function walk(node: MessageStructureObject, visit: (node: MessageStructureObject) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

/**
 * The part to render as the body: plain text if the sender provided it, HTML otherwise.
 *
 * Plain text is preferred even though the HTML alternative usually looks richer, because the plain
 * part is what the sender's client generated *for* a text reader — it needs no tag stripping, no
 * entity decoding, and no guessing about which `<div>` held the quoted thread.
 */
export function chooseBodyPart(structure: MessageStructureObject | undefined): BodyPartChoice | null {
  if (!structure) return null;

  const found: { plain?: MessageStructureObject; html?: MessageStructureObject } = {};

  walk(structure, (node) => {
    const type = node.type?.toLowerCase();
    if (isAttachmentNode(node)) return;
    if (type === 'text/plain' && !found.plain) found.plain = node;
    if (type === 'text/html' && !found.html) found.html = node;
  });

  const isPlain = Boolean(found.plain);
  const chosen = found.plain ?? found.html;
  if (!chosen) return null;

  return {
    part: chosen.part ?? null,
    type: isPlain ? 'text/plain' : 'text/html',
    encoding: chosen.encoding?.toLowerCase() ?? '7bit',
    charset: charsetOf(chosen),
  };
}

/** Every attachment in the message, as metadata only. */
export function listAttachmentParts(structure: MessageStructureObject | undefined): AttachmentMeta[] {
  if (!structure) return [];

  const found: AttachmentMeta[] = [];
  walk(structure, (node) => {
    if (!node.part || !isAttachmentNode(node)) return;
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? `part-${node.part}`;
    found.push({
      attachmentId: node.part,
      filename,
      mimeType: node.type?.toLowerCase() ?? 'application/octet-stream',
      bytes: node.size ?? 0,
    });
  });
  return found;
}

/**
 * Decode one fetched body part.
 *
 * imapflow reports which parts the server already decoded (`binaryParts`), so quoted-printable and
 * base64 are only unwound here when the server did not do it. Doing it twice mangles the text.
 */
export function decodeBodyPart(raw: Buffer, choice: BodyPartChoice, serverDecoded: boolean): string {
  let bytes = raw;

  if (!serverDecoded) {
    if (choice.encoding === 'base64') {
      bytes = Buffer.from(raw.toString('ascii'), 'base64');
    } else if (choice.encoding === 'quoted-printable') {
      bytes = Buffer.from(decodeQuotedPrintable(raw.toString('latin1')), 'latin1');
    }
  }

  const charset = choice.charset;
  if (charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii' || charset === 'ascii') {
    return bytes.toString('utf-8');
  }
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252') {
    return bytes.toString('latin1');
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // An unknown charset label is not a reason to lose the message. UTF-8 renders most of it and
    // mangles the accents, which beats returning nothing.
    return bytes.toString('utf-8');
  }
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
