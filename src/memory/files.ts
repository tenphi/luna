import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { translateWorkspacePath } from '../host-mcp/workspace-paths.js';
import { MemoryUnavailable, retryRead } from './client.js';

export type StagedMemoryFile = { filename: string } | { error: string };

/** Stage only an indexed original into the authenticated session's outbox. */
export async function stageMemoryFile(
  agentGroupId: string,
  sessionId: string,
  document: string,
  id: string,
  filename?: string,
): Promise<StagedMemoryFile> {
  if (typeof document !== 'string' || !document.trim()) return { error: 'A memory document id or path is required.' };
  if (!isSafeAttachmentName(id) || (filename !== undefined && !isSafeAttachmentName(filename))) {
    return { error: 'Invalid attachment filename or outbox id.' };
  }

  try {
    const source = await retryRead(async (client) => {
      const result = await client.read({ document: document.trim().replace(/^memory:/i, '') });
      return { root: client.hello.akno_path, document: result.document };
    });
    if (!source.document) return { error: 'No original file found. Use memory_read to find its document id.' };

    const root = fs.realpathSync(source.root);
    const rel = source.document.rel_path;
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part.startsWith('.'))) {
      return { error: 'The document path is outside the knowledge base or is an internal file.' };
    }
    const original = fs.realpathSync(path.join(root, rel));
    const relative = path.relative(root, original);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { error: 'The original file resolves outside the knowledge base.' };
    }
    const stat = fs.statSync(original);
    if (!stat.isFile()) return { error: 'The original is not a file.' };
    if (stat.size > 50 * 1024 * 1024) return { error: 'The original is over the 50MB messaging limit.' };

    const bytes = fs.readFileSync(original);
    if (createHash('sha256').update(bytes).digest('hex') !== source.document.sha256) {
      return { error: 'The original file has changed since memory indexed it. Refresh memory before sending it.' };
    }
    const name = filename ?? path.basename(rel);
    if (!isSafeAttachmentName(name)) return { error: 'Invalid attachment filename.' };
    const target = translateWorkspacePath(`/workspace/outbox/${id}/${name}`, { agentGroupId, sessionId });
    if (!target) return { error: 'The session outbox is unavailable.' };
    fs.mkdirSync(path.dirname(target.hostPath), { recursive: true });
    const fd = fs.openSync(
      target.hostPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    return { filename: name };
  } catch (error) {
    // Neither host paths nor extracted document text belong in a file-send result.
    if (error instanceof MemoryUnavailable)
      return { error: 'Memory is unavailable; the original file could not be retrieved.' };
    if ((error as NodeJS.ErrnoException)?.code === 'ELOOP') return { error: 'The session outbox contains a symlink.' };
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { error: 'The original file is missing; stored text alone cannot be sent as the original.' };
    }
    return {
      error:
        'Could not retrieve the original file from memory. Check memory_read for a unique document id and try again.',
    };
  }
}
