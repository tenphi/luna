import path from 'node:path';

const WORKSPACE_PATH = /\/workspace\/(?:[^\s`<>()[\]{}"']+\/)*[^\s`<>()[\]{}"']+/g;
const QUOTED_PATH = /`(\/workspace\/[^`]+)`/g;
const EXPLICIT_PATH_REQUEST = /\b(?:full|absolute|exact)\s+(?:file\s+)?path\b|\bshow (?:me )?(?:the )?path\b/i;

/** Human replies name files; tool calls and stored history keep their exact paths. */
export function displayFileNames(text: string, requestText = ''): string {
  if (!text.includes('/workspace/') || EXPLICIT_PATH_REQUEST.test(requestText)) return text;

  const paths = new Set<string>();
  for (const match of text.matchAll(QUOTED_PATH)) paths.add(match[1]!);
  for (const match of text.matchAll(WORKSPACE_PATH)) paths.add(match[0].replace(/[.,;:!?]+$/, ''));

  const byName = new Map<string, string[]>();
  for (const file of paths) {
    const name = path.posix.basename(file.replace(/\/$/, ''));
    if (!name || name === 'workspace') continue;
    const siblings = byName.get(name) ?? [];
    siblings.push(file);
    byName.set(name, siblings);
  }

  const label = (file: string): string => {
    const name = path.posix.basename(file.replace(/\/$/, ''));
    const siblings = byName.get(name) ?? [];
    return siblings.length > 1 ? `${name} (file ${siblings.indexOf(file) + 1})` : name;
  };

  return text
    .replace(QUOTED_PATH, (_whole, file: string) => `\`${label(file)}\``)
    .replace(WORKSPACE_PATH, (file) => {
      const clean = file.replace(/[.,;:!?]+$/, '');
      return label(clean) + file.slice(clean.length);
    });
}
