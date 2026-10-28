import fs from 'fs';
import path from 'path';

import type { MessageInRow } from './db/messages-in.js';

/** Staged image file passed to vision-capable providers. */
export interface ImageAttachment {
  /** Absolute path inside the container, e.g. `/workspace/inbox/msg-id/file.jpg`. */
  path: string;
  mimeType: string;
  /**
   * How to name this image where it is shown. Defaults to the basename, which
   * is ambiguous for memory files: every stored file takes its page's own name,
   * so two pages' attachments both announce as `id-card.jpg` and the model has
   * no way to tell which one it is looking at.
   */
  label?: string;
}

const WORKSPACE = '/workspace';
const INBOX_PREFIX = 'inbox/';

function workspaceRoot(): string {
  return process.env.LUNA_TEST_WORKSPACE ?? WORKSPACE;
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
};

const TYPE_TO_MIME: Record<string, string> = {
  image: 'image/jpeg',
  photo: 'image/jpeg',
  sticker: 'image/webp',
};

const MIME_PREFIX = 'image/';

function extFromName(name: unknown): string {
  if (typeof name !== 'string' || !name) return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Infer image MIME from attachment metadata (Telegram photos often lack explicit MIME). */
export function inferImageMime(att: Record<string, unknown>): string | null {
  const mime = att.mimeType;
  if (typeof mime === 'string' && mime.toLowerCase().startsWith(MIME_PREFIX)) {
    return mime.split(';')[0].trim().toLowerCase();
  }

  const fromName = EXT_TO_MIME[extFromName(att.name ?? att.filename)];
  if (fromName) return fromName;

  const attType = att.type;
  if (typeof attType === 'string') {
    const mapped = TYPE_TO_MIME[attType.toLowerCase()];
    if (mapped) return mapped;
  }

  return null;
}

export function isStagedImageAttachment(att: Record<string, unknown>): boolean {
  return inferImageMime(att) !== null && typeof att.localPath === 'string';
}

/**
 * Resolve a host-staged `localPath` (relative to `/workspace`) to an absolute
 * inbox file path. Rejects traversal and paths outside `inbox/`.
 *
 * Nothing here is image-specific — `attachment-digest.ts` needs the same
 * containment check for PDFs and office documents.
 */
export function resolveStagedInboxPath(localPath: unknown): string | null {
  if (typeof localPath !== 'string' || !localPath.startsWith(INBOX_PREFIX)) return null;
  if (localPath.includes('..') || localPath.includes('\0')) return null;

  const root = workspaceRoot();
  const full = path.normalize(path.join(root, localPath));
  const inboxRoot = path.normalize(path.join(root, 'inbox'));
  if (full !== inboxRoot && !full.startsWith(`${inboxRoot}${path.sep}`)) return null;
  return full;
}

/** A host-staged inbound attachment of any type, resolved to a real file. */
export interface StagedAttachment {
  /** Absolute path inside the container, e.g. `/workspace/inbox/msg-1/bill.pdf`. */
  path: string;
  /** `inbox/<msgId>/<file>` — stable identity for the digest cache. */
  localPath: string;
  /** Channel-provided filename. Never used to name anything stored. */
  name: string;
  /** Declared MIME, when the channel sent one. */
  mimeType?: string;
  /** True when the bytes also went to the model as vision input. */
  isImage: boolean;
  bytes: number;
}

/**
 * Every staged attachment on a batch, images included.
 *
 * `collectImageAttachments` deliberately drops anything without an image MIME —
 * it feeds the vision path. This is the superset the digest stage needs, because
 * a caption-less PDF is exactly the case that used to reach the topic classifier
 * as nothing at all.
 */
export function collectStagedAttachments(messages: MessageInRow[]): StagedAttachment[] {
  const out: StagedAttachment[] = [];

  for (const msg of messages) {
    if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') continue;
    const content = parseContent(msg.content);
    const attachments = content.attachments;
    if (!Array.isArray(attachments)) continue;

    for (const raw of attachments) {
      if (!raw || typeof raw !== 'object') continue;
      const att = raw as Record<string, unknown>;
      const filePath = resolveStagedInboxPath(att.localPath);
      if (!filePath) continue;

      let bytes: number;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        bytes = stat.size;
      } catch {
        continue;
      }

      const mime = inferImageMime(att) ?? (typeof att.mimeType === 'string' ? att.mimeType : undefined);
      out.push({
        path: filePath,
        localPath: att.localPath as string,
        name: typeof att.name === 'string' && att.name ? att.name : path.basename(filePath),
        mimeType: mime,
        isImage: inferImageMime(att) !== null,
        bytes,
      });
    }
  }

  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

/** Collect staged image files from chat messages for multimodal provider input. */
export function collectImageAttachments(messages: MessageInRow[]): ImageAttachment[] {
  const images: ImageAttachment[] = [];

  for (const msg of messages) {
    if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') continue;
    const content = parseContent(msg.content);
    const attachments = content.attachments;
    if (!Array.isArray(attachments)) continue;

    for (const raw of attachments) {
      if (!raw || typeof raw !== 'object') continue;
      const att = raw as Record<string, unknown>;
      const mimeType = inferImageMime(att);
      if (!mimeType) continue;

      const filePath = resolveStagedInboxPath(att.localPath);
      if (!filePath) continue;

      try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      } catch {
        continue;
      }

      images.push({ path: filePath, mimeType });
    }
  }

  return images;
}
