/**
 * Normalize memory page slugs before MCP calls.
 *
 * Agents (and some tool UIs) often pass filesystem-style names like
 * `people/jane.md`. A write stores the slug as-is and the file it produces
 * lands at `<memory>/<slug>.md`, which becomes `people/jane.md.md` when the
 * extension is already present. Sync's `pathToSlug` strips `.md`; put_page does
 * not — so Luna strips it at the bridge.
 */

/** Strip leading slashes and any trailing `.md` / `.mdx` (possibly repeated). */
export function normalizeMemorySlug(slug: string): string {
  let s = slug.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  while (/\.mdx?$/i.test(s)) {
    s = s.replace(/\.mdx?$/i, '');
  }
  return s;
}

const SLUG_ARG_KEYS = new Set(['slug', 'from_slug', 'to_slug', 'entity_slug', 'page_slug', 'target_slug']);

function isSlugArgKey(key: string): boolean {
  return SLUG_ARG_KEYS.has(key) || key.endsWith('_slug');
}

/**
 * Return a shallow copy of `args` with known slug fields normalized.
 * Non-string / missing values are left untouched.
 */
export function normalizeMemoryToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(out)) {
    if (!isSlugArgKey(key) || typeof value !== 'string' || !value) continue;
    const normalized = normalizeMemorySlug(value);
    if (normalized !== value) {
      out[key] = normalized;
      changed = true;
    }
  }
  return changed ? out : args;
}
