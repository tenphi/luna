/**
 * Shared primitives for binary attachments in the knowledge base.
 *
 * A **page** is a slug without extension (`receipts/2026-07-27-cafe`); a
 * **file** is a memory-relative path *with* extension
 * (`receipts/2026-07-27-cafe.jpg`). They are siblings in the same folder, so
 * the memory stays human-browsable and Obsidian renders the file inline from the
 * page's `![[…]]` embed.
 *
 * Two invariants hold everything together:
 *
 *   1. **Every file is embedded by its page.** The page body is a file's only
 *      durable reference — memory re-renders `<memory>/<slug>.md` from its own record
 *      on every `put_page`, so the embed has to travel through page content like
 *      anything else. Luna guarantees the embed exists; the model owns the rest
 *      of the body.
 *   2. **A file's name *is* its page's basename**, give or take an extension and
 *      a `-2`/`-3` collision number. That is what lets
 *      {@link siblingAttachments} and `list` resolve a file's owning page by
 *      convention instead of scanning every page body in memory. Knowledge bases
 *      written before this rule may still hold `<page>-<label>.ext` files; both
 *      resolvers keep handling those.
 *
 * Non-`.md` files are inert to the indexer: sync is git-HEAD-based over markdown and
 * the folder tree only counts `.md`, so the bytes sitting next to a page never
 * reach the graph.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

/** Memory-relative id vocabulary shared by every surface that names a file. */
export const MEMORY_URI_PREFIX = 'memory:';


/**
 * Read-only copies for `get`. The session dir, not `/workspace/agent` — that
 * one is the install agent dir, shared across sessions and living in the git
 * repo, so a cache there would pollute the repo and leak between sessions.
 */
export function memoryCacheDir(): string {
  return path.join(process.env.LUNA_TEST_WORKSPACE ?? '/workspace', '.memory-cache');
}

/**
 * 0444 copies of memory files, keyed by mirroring the memory tree.
 *
 * Keying on `path.basename` is what made two pages' attachments collide: a
 * stored file always takes its page's own name (invariant 2 above), so sibling
 * pages under different scopes routinely share a leaf name
 * (`alice/id-card.jpg` vs `bob/id-card.jpg`). One
 * cache path for both meant the second `get` either died on the first copy's
 * 0444 or — worse, since tool-result images are read at drain time, after the
 * whole batch — silently handed the model one file's bytes twice under two
 * different names.
 */
export function memoryCacheFilesDir(): string {
  return path.join(memoryCacheDir(), 'files');
}

/**
 * Writable derived artifacts (page renders, `.txt` sidecars), kept out of
 * {@link memoryCacheFilesDir} so a derived write can never land on a 0444 path.
 */
export function memoryCacheDerivedDir(): string {
  return path.join(memoryCacheDir(), 'derived');
}

/**
 * Cache path for a memory file: the memory tree, mirrored.
 *
 * `rel` is already validated by {@link validateMemoryRelPath} (no `..`, no `.`,
 * not absolute, no NUL, must carry an extension) before any caller holds a
 * `ResolvedMemoryFile`, so this join is total and injective — no separator
 * ambiguity to resolve and no 255-byte truncation to tie-break, which a
 * flattened `a__b__c.jpg` scheme would both need. Containment is re-asserted
 * anyway, in case a future caller skips the validator.
 */
export function memoryCachePath(rel: string): string {
  const root = memoryCacheFilesDir();
  const abs = path.resolve(root, rel);
  const within = path.relative(root, abs);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error(`refusing to cache outside the cache root: ${rel}`);
  }
  return abs;
}

/** Short, filesystem-safe token for a source identity (memory rel or abs path). */
function cacheToken(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/**
 * Per-source dir for writable derived artifacts. Created, never wiped — the
 * `.txt` sidecar path is handed to the model so it can quote past the clip, so a
 * second extraction must overwrite that one name rather than delete a directory
 * out from under a path already in the conversation.
 */
export function derivedDirFor(source: string): string {
  const dir = path.join(memoryCacheDerivedDir(), cacheToken(source));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fresh, empty subdir for one call's page renders.
 *
 * Wiped on every call because `renderPdfPages` returns a *glob* of its output
 * dir rather than the files it just wrote, so stale PNGs from an earlier render
 * of the same prefix would otherwise be served as pages of the current file.
 */
export function renderDirFor(source: string): string {
  const dir = path.join(derivedDirFor(source), 'pages');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Stage a read-only working copy of a memory file. Idempotent, and safe to call
 * twice for the same file or for two files sharing a basename.
 *
 * Copy to a temp name, chmod, then rename over the destination: `copyFileSync`
 * onto an existing 0444 file is the EACCES, because the *target file's* mode is
 * what blocks the write, whereas `rename(2)` is governed by write permission on
 * the containing directory — which this process owns. Rename also makes the
 * swap atomic, so a path the model already holds from earlier in the same batch
 * never observes a truncated file, and a copy that dies midway leaves an orphan
 * `.tmp-*` rather than a short, writable file posing as the working copy.
 */
export function stageMemoryFileCopy(rel: string, abs: string): { path: string } | { error: string } {
  const dest = memoryCachePath(rel);
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Always re-copy rather than short-circuiting on size+mtime, so
    // `replace_files` followed by `get` is correct with no freshness heuristic.
    fs.copyFileSync(abs, tmp);
    fs.chmodSync(tmp, 0o444);
    fs.renameSync(tmp, dest);
    return { path: dest };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort — an orphan temp file is not worth failing the read over.
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const DEFAULT_MAX_FILE_MB = 25;
const DEFAULT_MAX_VIEW_IMAGES = 4;

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

/** Image MIME types the provider can pass through as vision input. */
const VIEWABLE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// --- Config (env-injected at spawn) ---------------------------------------

export function maxFileBytes(): number {
  const raw = Number(process.env.LUNA_MEMORY_FILES_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_MB;
  return Math.floor(mb * 1024 * 1024);
}

export function maxViewImages(): number {
  const raw = Number(process.env.LUNA_MEMORY_FILES_MAX_VIEW_IMAGES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_VIEW_IMAGES;
}

function blockedExtensions(): Set<string> {
  const raw = process.env.LUNA_MEMORY_FILES_BLOCKED_EXT ?? '';
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean),
  );
}

// --- Roots ----------------------------------------------------------------

/** Memory root inside the container. Null in the normal case: the KB is not mounted. */
export function memoryRoot(): string | null {
  const raw = process.env.LUNA_MEMORY_PATH;
  if (!raw || !raw.trim()) return null;
  return path.resolve(raw.trim());
}

// --- Naming ---------------------------------------------------------------

export function extensionOf(name: string): string {
  const base = path.basename(name);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function mimeFor(name: string): string {
  return EXT_TO_MIME[extensionOf(name)] ?? 'application/octet-stream';
}

export function isViewableImage(name: string): boolean {
  return VIEWABLE_IMAGE_MIMES.has(mimeFor(name));
}

/** Strip characters that would break a wikilink or a shell path. */
function sanitizeSegment(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[[\]|#^\\/]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
}

/**
 * The stored name for a file attached to `slug`: the page's own basename plus
 * the *source* extension.
 *
 * The agent has no say in this. It used to pass a purpose label that was
 * prefixed with the page basename, and what the model actually did with that
 * freedom was echo the incoming filename — turning page
 * `receipts/vulpine-mutual-annual-bill-2031-04-02` into
 * `vulpine-mutual-annual-bill-2031-04-02-vulpine-mutual-invoice-00412.pdf`. A page and
 * its files now share one name, so the only thing that ever distinguishes them
 * is the extension, or a `-2`/`-3` collision number from
 * {@link uniqueAttachmentName}.
 *
 * The extension comes from the source rather than from anything the agent
 * typed: the model routinely omits or guesses it wrong, and the extension is
 * what decides the MIME type.
 */
export function attachmentNameFor(slug: string, sourceName: string): string {
  const pageBase = sanitizeSegment(path.basename(slug)) || 'file';
  const ext = extensionOf(sourceName);
  return ext ? `${pageBase}.${ext}` : pageBase;
}

/**
 * First free name in `dir`, auto-suffixing `-2`, `-3`, … before the extension.
 *
 * `vacating` (basenames, matched case-insensitively) count as free: a move
 * renames files *within* a folder — and on a case-insensitive filesystem a
 * case-only rename does not even change the folder — so the file about to leave
 * a name must not block the file taking it, or `People/Jane` → `people/jane`
 * diverts to `jane-2.jpg`.
 */
export function uniqueAttachmentName(
  dir: string,
  desired: string,
  taken: Set<string> = new Set(),
  vacating: Set<string> = new Set(),
): string {
  const free = new Set([...vacating].map((name) => name.toLowerCase()));
  const ext = path.extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  let candidate = desired;
  let n = 1;
  while (taken.has(candidate) || (!free.has(candidate.toLowerCase()) && fs.existsSync(path.join(dir, candidate)))) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
  return candidate;
}

// --- Resolution -----------------------------------------------------------

/** Either a resolved absolute path or an agent-facing error string. */
export type PathResult = { abs: string } | { error: string };

export interface ResolvedMemoryFile {
  /** Memory-relative path with extension, e.g. `receipts/cafe.jpg`. */
  rel: string;
  /** Absolute path inside the container. */
  abs: string;
  /** Canonical id the agent sees everywhere. */
  id: string;
}

export function memoryFileId(rel: string): string {
  return `${MEMORY_URI_PREFIX}${rel}`;
}

/** Strip the `memory:` prefix and normalize separators. Does not touch disk. */
export function stripMemoryPrefix(raw: string): string {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.toLowerCase().startsWith(MEMORY_URI_PREFIX)
    ? trimmed.slice(MEMORY_URI_PREFIX.length)
    : trimmed;
  return withoutPrefix.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

/**
 * Validate a memory-relative path. Pages own `.md`, so those are refused here —
 * a file tool pointed at a page would bypass the graph entirely.
 */
export function validateMemoryRelPath(rel: string): string | null {
  if (!rel) return 'Error: a memory file id is required, e.g. "memory:receipts/2026-07-27-cafe.jpg".';
  if (rel.includes('\0')) return 'Error: invalid memory file id.';
  if (path.isAbsolute(rel)) {
    return `Error: use a memory-relative id ("${MEMORY_URI_PREFIX}folder/name.ext"), not an absolute path.`;
  }
  if (rel.split('/').some((seg) => seg === '..' || seg === '.')) {
    return 'Error: memory file ids cannot contain "." or ".." segments.';
  }
  if (/\.mdx?$/i.test(rel)) {
    return `Error: "${rel}" is a page, not a file. Use memory_read / memory_write for pages.`;
  }
  if (!extensionOf(rel)) {
    return `Error: "${rel}" has no file extension — memory file ids always include one.`;
  }
  const ext = extensionOf(rel);
  if (blockedExtensions().has(ext)) {
    return `Error: ".${ext}" files are not allowed in the knowledge base.`;
  }
  return null;
}

/** Every non-`.md` file in the memory, memory-relative. Skips dot-dirs (incl. `.sources`). */
export function listAllMemoryFiles(root = memoryRoot()): string[] {
  if (!root) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(path.join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile() && !/\.mdx?$/i.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  walk(root, '', 0);
  return out.sort();
}

/**
 * Resolve a `memory:` id to a real file.
 *
 * A bare basename is accepted when it is unique in the memory: page bodies carry
 * Obsidian wikilinks (`![[permit.jpg]]`) with no folder, so requiring the full
 * path would make the model reconstruct `dirname(slug) + wikilink` by hand.
 * Ambiguity is an error listing the candidates, never a silent pick.
 */
export function resolveMemoryFile(raw: string): ResolvedMemoryFile | string {
  const root = memoryRoot();
  if (!root) return 'Error: the knowledge base is not available.';

  const rel = stripMemoryPrefix(raw);
  const invalid = validateMemoryRelPath(rel);
  if (invalid) return invalid;

  const direct = resolveWithinRoot(root, rel);
  if ('error' in direct) return direct.error;
  if (fileExists(direct.abs)) return { rel, abs: direct.abs, id: memoryFileId(rel) };

  // Bare basename fallback.
  if (!rel.includes('/')) {
    const matches = listAllMemoryFiles(root).filter((candidate) => path.basename(candidate) === rel);
    if (matches.length === 1) {
      return { rel: matches[0]!, abs: path.join(root, matches[0]!), id: memoryFileId(matches[0]!) };
    }
    if (matches.length > 1) {
      return (
        `Error: "${rel}" matches ${matches.length} files in the knowledge base. Use the full id: ` +
        matches.map(memoryFileId).join(', ')
      );
    }
  }

  return `Error: no file "${rel}" in the knowledge base. Use memory_recall or memory_read to find what is stored.`;
}

/**
 * Join + confirm containment, defeating traversal and symlinked escapes.
 *
 * Exported because the user-facing read commands (`/read`, `/raw`, `/download`,
 * `/list` — see `memory-read.ts`) take a path typed by a human in a chat and need
 * the same guard. Reimplementing it as a `startsWith` check would drop the
 * `realpathSync` half, which is the half that catches a symlink pointing out.
 */
export function resolveWithinRoot(root: string, rel: string): PathResult {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    return { error: 'Error: that path is outside the knowledge base.' };
  }
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
      return { error: 'Error: that path resolves outside the knowledge base (symlink).' };
    }
  } catch {
    // Missing file is fine here — callers check existence themselves.
  }
  return { abs };
}

function fileExists(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

// --- Source (workspace) paths ---------------------------------------------

/** Absolute container path a source file may be read from before it is filed. */
export function resolveSourcePath(raw: string): PathResult {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Error: an empty file path was given.' };
  if (trimmed.toLowerCase().startsWith(MEMORY_URI_PREFIX)) {
    return {
      error: `Error: "${trimmed}" is already in the knowledge base. This tool takes container paths (e.g. /workspace/inbox/…), not memory: ids — use memory_read {document} for a stored file.`,
    };
  }
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve('/workspace/agent', trimmed);

  const root = memoryRoot();
  if (root && (abs === root || abs.startsWith(`${root}${path.sep}`))) {
    return {
      error: `Error: "${trimmed}" is already in the knowledge base — memory_read {document} returns its text without extracting it again.`,
    };
  }
  if (!fileExists(abs)) return { error: `Error: file not found: ${trimmed}` };
  return { abs };
}

export function fileSize(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Embeds ---------------------------------------------------------------

const EMBED_RE = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/** Filenames embedded by a page body, in `![[name]]` form. */
export function scanEmbeds(body: string): Set<string> {
  const out = new Set<string>();
  for (const match of body.matchAll(EMBED_RE)) {
    const target = match[1]?.trim();
    if (target) out.add(path.basename(target));
  }
  return out;
}

/**
 * One stored file as the body needs to describe it.
 *
 * `label` is what the *call* said this particular file is ("bio-data page",
 * "renewal, valid to 2031"). It never touches the stored filename — a page's
 * files all share the page's name, so the body is the only place that can say
 * which is which, and a bare list of embeds cannot.
 */
export interface AttachedFile {
  /** Stored filename, e.g. `permit-ada-marlow-2.jpg`. */
  name: string;
  /** What this file is, when the call labeled it. */
  label?: string;
}

export type EmbedTarget = string | AttachedFile;

function toAttached(file: EmbedTarget): AttachedFile {
  return typeof file === 'string'
    ? { name: path.basename(file) }
    : { name: path.basename(file.name), label: file.label?.trim() || undefined };
}

const FILES_HEADING_RE = /^#{1,6}[ \t]+Files[ \t]*$/;

/** True when the body already says, on the embed's own line, what that file is. */
function labelIsOnEmbedLine(body: string, file: AttachedFile): boolean {
  if (!file.label) return false;
  const needle = file.label.toLowerCase();
  for (const line of body.split('\n')) {
    if (!line.includes(`[[${file.name}`)) continue;
    if (line.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** Append lines to the body's existing `## Files` section, or start one. */
function appendToFilesSection(body: string, lines: string[]): string {
  const bodyLines = body.replace(/\s+$/, '').split('\n');
  let heading = -1;
  for (let i = bodyLines.length - 1; i >= 0; i--) {
    if (FILES_HEADING_RE.test(bodyLines[i]!)) {
      heading = i;
      break;
    }
  }

  if (heading === -1) {
    const block = ['## Files', '', ...lines].join('\n');
    const trimmed = bodyLines.join('\n');
    return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  }

  // End of that section: the next heading, or the end of the body.
  let end = bodyLines.length;
  for (let i = heading + 1; i < bodyLines.length; i++) {
    if (/^#{1,6}[ \t]+/.test(bodyLines[i]!)) {
      end = i;
      break;
    }
  }
  while (end > heading + 1 && bodyLines[end - 1]!.trim() === '') end -= 1;
  bodyLines.splice(end, 0, ...lines);
  return `${bodyLines.join('\n')}\n`;
}

/**
 * Guarantee every attached file is referenced by the page, and — when the call
 * labeled them — that the page says which file is which.
 *
 * Unlabeled and already-described files come back **byte-for-byte**: the
 * generated `## Files` block is a backstop, not the normal shape of a page. A
 * page whose subject *is* the document should read as the document, with the
 * embed wherever the model put it.
 *
 * A file the body already embeds in prose is listed with a plain `[[name]]` so
 * the image is not rendered twice; the prose embed is what keeps
 * {@link scanEmbeds} accounting honest, and {@link removeEmbeds} strips these
 * index lines whole.
 */
export function appendMissingEmbeds(body: string, files: EmbedTarget[]): string {
  const entries = files.map(toAttached);
  const present = scanEmbeds(body);

  if (!entries.some((entry) => entry.label)) {
    const missing = entries.filter((entry) => !present.has(entry.name));
    if (missing.length === 0) return body;
    return appendToFilesSection(
      body,
      missing.map((entry) => `![[${entry.name}]]`),
    );
  }

  const lines: string[] = [];
  for (const entry of entries) {
    const embedded = present.has(entry.name);
    if (embedded && (!entry.label || labelIsOnEmbedLine(body, entry))) continue;
    const link = embedded ? `[[${entry.name}]]` : `![[${entry.name}]]`;
    lines.push(entry.label ? `- ${link} — ${entry.label}` : `- ${link}`);
  }
  if (lines.length === 0) return body;
  return appendToFilesSection(body, lines);
}

/** `- ![[name]] — label` / `- [[name]] — label`, the generated index shape. */
const INDEX_LINE_RE = /^[ \t]*[-*][ \t]*!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/;

/** Max label length in a page body — a caption, not a paragraph. */
export const MAX_LABEL_CHARS = 80;

/**
 * Read labels back out of the `- ![[name]] — label` shape the writer emits,
 * keyed by file basename.
 *
 * Scoped to the bullet shape on purpose, matching {@link labelIsOnEmbedLine}'s
 * "a label lives on its embed's own line" convention: a bare `[[people/jane]]`
 * in prose is a page cross-link, and falling back to "any prose near the embed"
 * would caption a file with a paragraph.
 */
export function embedLabels(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = INDEX_LINE_RE.exec(line);
    if (!match) continue;
    const rest = line
      .slice(match.index + match[0].length)
      .replace(/^[ \t]*[—–:-][ \t]*/, '')
      .trim();
    if (!rest) continue;
    const base = path.basename(match[1]!.trim());
    if (out.has(base)) continue;
    out.set(base, rest.length > MAX_LABEL_CHARS ? `${rest.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : rest);
  }
  return out;
}

/**
 * Drop references to files this change removed.
 *
 * Only ever called with names the operation itself trashed, so a page cannot end
 * up advertising bytes that are gone — the one inconsistency replace and delete
 * can otherwise introduce. Generated index lines go whole: stripping just the
 * `![[…]]` token out of `- ![[permit-2.jpg]] — back page` would leave
 * `-  — back page`, a caption for nothing.
 */
export function removeEmbeds(body: string, filenames: string[]): string {
  const targets = new Set(filenames.map((name) => path.basename(name)));
  if (targets.size === 0) return body;

  const kept = body.split('\n').filter((line) => {
    const match = INDEX_LINE_RE.exec(line);
    return !match || !targets.has(path.basename(match[1]!.trim()));
  });

  const stripped = kept
    .join('\n')
    .replace(EMBED_RE, (whole, target: string) => (targets.has(path.basename(target.trim())) ? '' : whole));
  // Collapse the blank lines and now-empty `## Files` heading left behind.
  return stripped
    .replace(/^[ \t]*\n(?=[ \t]*\n)/gm, '')
    .replace(/\n#{1,6} Files[ \t]*\n(?=\s*(?:\n#|$))/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Rewrite `![[old]]` → `![[new]]` for a set of renames (used by move).
 *
 * Generated index lines may hold a plain `[[name]]` for a file the prose already
 * embeds, so those are rewritten too — scoped to the bullet shape, because a bare
 * `[[people/jane]]` in prose is a page cross-link and must not be touched.
 */
export function rewriteEmbeds(body: string, renames: Map<string, string>): string {
  const lines = body.split('\n').map((line) => {
    let out = line;
    const match = INDEX_LINE_RE.exec(line);
    // Only the `!`-less form needs the extra pass, and doing it before the embed
    // pass would re-rewrite it when one file's old name is another's new one.
    if (match && !match[0].includes('![[')) {
      const replacement = renames.get(path.basename(match[1]!.trim()));
      if (replacement) out = out.replace(`[[${match[1]}`, `[[${replacement}`);
    }
    return out.replace(EMBED_RE, (whole, target: string) => {
      const base = path.basename(target.trim());
      const next = renames.get(base);
      return next ? `![[${next}]]` : whole;
    });
  });
  return lines.join('\n');
}

// --- Siblings -------------------------------------------------------------

/**
 * Files belonging to `slug` by the basename convention: `foo.jpg`, `foo-2.pdf`
 * next to `foo.md`. Cheaper and more predictable than scanning page bodies, and
 * it is why {@link attachmentNameFor} forces the page's name.
 *
 * The prefix match alone over-claims: with pages `receipts/bill` and
 * `receipts/bill-2031-04-02` in one folder, `bill` would claim the other page's
 * `bill-2031-04-02.pdf` — and callers *destroy* what this returns
 * (`replace_files: true` trashes it, `delete_memory_page` deletes it,
 * a page move renames it alongside). Date-suffixed slugs are
 * ordinary, so every candidate is confirmed against {@link owningPageSlug}.
 * An unowned file is kept: `applyAttachments` runs *before* the page `.md`
 * exists on a create, and adopting bytes a failed earlier write left behind is
 * the desired behavior.
 */
export function siblingAttachments(slug: string): string[] {
  const root = memoryRoot();
  if (!root) return [];
  const dir = path.dirname(slug) === '.' ? '' : path.dirname(slug);
  const base = path.basename(slug);
  const absDir = path.join(root, dir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || /\.mdx?$/i.test(entry.name)) continue;
    const stem = entry.name.slice(0, entry.name.length - path.extname(entry.name).length);
    if (stem !== base && !stem.startsWith(`${base}-`)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    // A suffixed name may belong to a longer page in the same folder.
    if (stem !== base) {
      const owner = owningPageSlug(rel);
      if (owner !== null && owner !== slug) continue;
    }
    out.push(rel);
  }
  return out.sort();
}

/** Owning page slug for a file, by the same convention. Null when orphaned. */
export function owningPageSlug(rel: string): string | null {
  const root = memoryRoot();
  if (!root) return null;
  const dir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
  const stem = path.basename(rel, path.extname(rel));

  // `foo-2.jpg` belongs to `foo`, so peel numeric/purpose suffixes back to the
  // longest existing page.
  const candidates = [stem];
  let cursor = stem;
  while (cursor.includes('-')) {
    cursor = cursor.slice(0, cursor.lastIndexOf('-'));
    if (cursor) candidates.push(cursor);
  }

  for (const candidate of candidates) {
    const slug = dir ? `${dir}/${candidate}` : candidate;
    if (fileExists(path.join(root, `${slug}.md`))) return slug;
  }
  return null;
}

