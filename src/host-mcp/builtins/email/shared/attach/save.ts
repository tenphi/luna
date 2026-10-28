/**
 * Putting an attachment where the agent can reach it — and where memory can.
 *
 * The file goes into the calling session's own workspace mount, and what comes back is the
 * *container* path. That is the whole trick behind "save this invoice to memory": the agent cannot
 * see host paths and memory cannot see container paths, but `translateWorkspacePath` already maps
 * between them for exactly this reason, so `save_attachment` → `memory ingest` works with no new
 * plumbing and no host path ever crossing into the sandbox.
 *
 * Filenames come from the message, which means they come from whoever sent it — an untrusted
 * source that lands in a `path.join`. `isSafeAttachmentName` is the existing guard against a name
 * that navigates out of the directory it was meant to land in.
 */
import fs from 'fs';
import path from 'path';

import { extForMime } from '../../../../../attachment-naming.js';
import { isSafeAttachmentName } from '../../../../../attachment-safety.js';
import type { HostMcpCaller } from '../../../../caller-context.js';
import { translateWorkspacePath, WORKSPACE } from '../../../../workspace-paths.js';
import type { AttachmentMeta } from '../types.js';

/** Where saved attachments land, under the session's workspace. */
const SUBDIR = 'inbox/mail';

export interface SavedAttachment {
  containerPath: string;
  filename: string;
}

/**
 * A name that is safe to join onto a path, keeping the extension where possible.
 *
 * The extension is worth preserving beyond tidiness: memory's ingest dispatches on it, so an
 * `invoice.pdf` saved as `attachment-1739` would be handed to the wrong extractor.
 */
function safeName(meta: AttachmentMeta): string {
  // Tested as sent, deliberately not `path.basename`d first. Basename-ing would quietly turn
  // `../../../../etc/passwd` into `passwd` and save it under that name — contained, but it lets a
  // sender pick the filename by way of an attempted traversal. A name that needed repair is not
  // trusted enough to use; the generated one below is.
  const raw = meta.filename ?? '';
  if (raw && isSafeAttachmentName(raw)) return raw;

  // A name that navigates, or none at all. `attachmentId` rather than a timestamp so two files
  // rescued from one message do not collide, and the extension is recovered from the MIME type so
  // memory's ingest still dispatches correctly.
  const ext = extForMime(meta.mimeType);
  const stem = `attachment-${meta.attachmentId.replace(/[^0-9A-Za-z]/g, '-')}`;
  return ext ? `${stem}.${ext}` : stem;
}

/** Avoid clobbering a file the agent saved a moment ago under the same name. */
function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
  }
  return candidate;
}

export function saveToWorkspace(
  meta: AttachmentMeta,
  bytes: Buffer,
  caller: HostMcpCaller | undefined,
): SavedAttachment {
  const containerDir = `${WORKSPACE}/${SUBDIR}`;
  const translation = translateWorkspacePath(containerDir, caller);
  if (!translation) {
    // No session means no workspace mount — a CLI or scheduled caller. Saying which tool to use
    // instead beats writing the file somewhere nobody will look for it.
    throw new Error('This conversation has no workspace to save into. Use read_attachment to read the file instead.');
  }

  fs.mkdirSync(translation.hostPath, { recursive: true });
  const target = uniquePath(translation.hostPath, safeName(meta));
  fs.writeFileSync(target, bytes);

  const filename = path.basename(target);
  return { containerPath: `${containerDir}/${filename}`, filename };
}
