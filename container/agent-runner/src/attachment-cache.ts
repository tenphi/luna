/**
 * Cache for attachment digests.
 *
 * A digest costs a subprocess and sometimes a model call, and the same inbox
 * file is looked at more than once: a steering push re-drains the batch, a
 * container killed mid-turn has its `processing` rows reset by the host sweep
 * and the replacement replays the same messages, and the agent may later call
 * `extract_document` on a file the intake already read.
 *
 * The key is `localPath|size|mtimeMs`. Inbox files are written once with the
 * `wx` flag and never mutated, so there is no need to hash 25MB of PDF to know
 * it is the same file. A re-sent identical file arrives under a new `messageId`,
 * so it gets a new path and a cache miss — which is correct: it is a new
 * message, and the topic decision has to see it as one.
 *
 * Two tiers. The in-memory map covers a container's own lifetime; the on-disk
 * sidecar under `/workspace/.attachment-cache/` survives a container swap and is
 * also where the `.txt` extraction lives, since that path is handed to the agent
 * for filing with `memory_ingest`.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

/** What a digest run learned about one file. Persisted as `digest.json`. */
export interface AttachmentDigest {
  name: string;
  mimeType?: string;
  bytes: number;
  isImage: boolean;
  /** Extracted or described text, already length-capped. Null when nothing worked. */
  text: string | null;
  /** `pdftotext` | `pandoc` | `tesseract` | `read` | `vision`, for provenance. */
  tool: string | null;
  /** Absolute path to the full extracted text, when it was worth writing out. */
  textPath?: string;
  /**
   * True when `text` is a prefix of what was actually extracted. Recorded here
   * rather than inferred at render time: `text` is already clipped by the time
   * anything renders it, so the two lengths always match and the "there is more"
   * signal would be lost exactly when it matters.
   */
  truncated?: boolean;
  pages?: number;
  /** True when `text` came from a model describing the file rather than from bytes. */
  described?: boolean;
  /** Why nothing was extracted, for the digest block and the logs. */
  failure?: string;
}

/** Cap on live entries; a session's inbox is small, this is a leak guard. */
const MAX_MEMORY_ENTRIES = 64;
/** Total bytes the on-disk sidecar may hold before the oldest runs are pruned. */
const MAX_DISK_BYTES = 16 * 1024 * 1024;

const memory = new Map<string, AttachmentDigest>();

function log(msg: string): void {
  console.error(`[attachment-cache] ${msg}`);
}

export function cacheRoot(): string {
  return path.join(process.env.LUNA_TEST_WORKSPACE ?? '/workspace', '.attachment-cache');
}

/** Identity of a staged file: its path plus the size/mtime pair. */
export function cacheKey(localPath: string, bytes: number, absPath: string): string {
  let mtime = 0;
  try {
    mtime = Math.floor(fs.statSync(absPath).mtimeMs);
  } catch {
    /* a vanished file just gets a weaker key */
  }
  return createHash('sha256').update(`${localPath}|${bytes}|${mtime}`).digest('hex').slice(0, 32);
}

function entryDir(key: string): string {
  return path.join(cacheRoot(), key);
}

export function readCached(key: string): AttachmentDigest | null {
  const live = memory.get(key);
  if (live) return live;

  try {
    const raw = fs.readFileSync(path.join(entryDir(key), 'digest.json'), 'utf-8');
    const parsed = JSON.parse(raw) as AttachmentDigest;
    // A sidecar whose `.txt` was pruned would hand the agent a dead path.
    if (parsed.textPath && !fs.existsSync(parsed.textPath)) delete parsed.textPath;
    memory.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Store a digest and, when there is extracted text, write it out as a `.txt`
 * beside it — that file is what `extract_document` hands the agent to attach.
 *
 * The `.txt` is named after the *source* file, not the eventual memory page: at
 * this point no page exists, and `memory_ingest` names the stored file itself on
 * the way into the memory.
 */
export function writeCached(key: string, digest: AttachmentDigest, fullText?: string): AttachmentDigest {
  let stored = digest;
  const dir = entryDir(key);

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fullText && fullText.trim()) {
      const base = path.basename(digest.name, path.extname(digest.name)) || 'document';
      const textPath = path.join(dir, `${base}.txt`);
      fs.writeFileSync(textPath, fullText);
      stored = { ...digest, textPath };
    }
    fs.writeFileSync(path.join(dir, 'digest.json'), JSON.stringify(stored));
  } catch (err) {
    // A cache that cannot be written is still a working digest.
    log(`Could not persist digest: ${err instanceof Error ? err.message : String(err)}`);
  }

  memory.set(key, stored);
  if (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  pruneDisk();
  return stored;
}

/** Drop the oldest entries once the sidecar outgrows its budget. */
function pruneDisk(): void {
  const root = cacheRoot();
  let entries: { dir: string; bytes: number; mtimeMs: number }[];
  try {
    entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = path.join(root, e.name);
        let bytes = 0;
        let mtimeMs = 0;
        for (const f of fs.readdirSync(dir)) {
          try {
            const stat = fs.statSync(path.join(dir, f));
            bytes += stat.size;
            mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
          } catch {
            /* mid-prune race */
          }
        }
        return { dir, bytes, mtimeMs };
      });
  } catch {
    return;
  }

  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= MAX_DISK_BYTES) return;

  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= MAX_DISK_BYTES) break;
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      total -= entry.bytes;
      log(`Pruned ${path.basename(entry.dir)} (${entry.bytes} bytes)`);
    } catch {
      /* best effort */
    }
  }
}

export function resetAttachmentCacheForTests(): void {
  memory.clear();
}
