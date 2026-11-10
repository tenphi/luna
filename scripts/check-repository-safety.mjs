#!/usr/bin/env node
// Findings contain locations and categories only. Never print matched private values.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const history = process.argv.includes('--history');
const rootArg = process.argv.indexOf('--root');
const treeRoot = rootArg < 0 ? null : path.resolve(process.argv[rootArg + 1]);
const termsFile = process.env.LUNA_PRIVACY_TERMS_FILE;
const terms = termsFile
  ? JSON.parse(fs.readFileSync(termsFile, 'utf8'))
  : JSON.parse(process.env.LUNA_PRIVACY_TERMS_JSON || '[]');
if (!Array.isArray(terms) || terms.some((term) => typeof term !== 'string' || !term.trim())) {
  throw new Error('The private terms file must contain a JSON array of nonempty strings.');
}
const patterns = [
  [
    'credential',
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|\d{8,12}:[A-Za-z0-9_-]{30,})/,
  ],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['machine home path', /\/(?:Users|home)\/(?!\b(?:me|user|test|example|node|runner)\b)[A-Za-z][\w.-]+/],
  [
    // Allowed: Anthropic's co-author address and GitHub's own committer for commits made
    // through its API, such as the Changesets version commit.
    'non-example email',
    /\b(?!(?:noreply@anthropic\.com|noreply@github\.com)\b)[A-Za-z0-9._%+-]+@(?![\w.-]*\b(?:example\.(?:com|org|net|test)|example|test|invalid|localhost|users\.noreply\.github\.com)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i,
  ],
];
let checked = 0;
const findings = [];
const attributionHashes = new Set(
  JSON.parse(fs.readFileSync(new URL('./public-attribution-hashes.json', import.meta.url), 'utf8')).sha256,
);
function scan(label, bytes) {
  checked++;
  const text = bytes.toString('utf8');
  for (const [category, regex] of patterns) {
    for (const match of text.matchAll(new RegExp(regex.source, regex.flags + 'g'))) {
      if (
        category === 'non-example email' &&
        treeRoot &&
        /^(?:_astro|pagefind)\/.*\.js$/.test(label) &&
        attributionHashes.has(createHash('sha256').update(match[0].toLowerCase()).digest('hex'))
      )
        continue;
      findings.push({ location: label, line: text.slice(0, match.index).split('\n').length, category });
    }
  }
  const lower = text.toLowerCase();
  const normalized = lower.replace(/[-_]/g, ' ');
  if (
    terms.some(
      (term) => lower.includes(term.toLowerCase()) || normalized.includes(term.toLowerCase().replace(/[-_]/g, ' ')),
    )
  )
    findings.push({ location: label, category: 'private identifier' });
}
function forbidden(file) {
  return (
    /^(?:data|logs|memory|agent|store|output|\.luna)(?:\/|$)/.test(file) ||
    /(?:^|\/)(?:\.env(?!\.example$)(?:\.[^/]+)?|local\.jsonc|\.DS_Store|AGENTS\.local\.md|\.agents-shared\.md)$/.test(
      file,
    ) ||
    /\.(?:db|sqlite|sqlite3|keys\.json)$/.test(file)
  );
}
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) {
      findings.push({ location: name, category: 'unexpected symlink' });
      return [];
    }
    return entry.isDirectory() ? walk(path.join(dir, entry.name), name + '/') : [name];
  });
}
if (history) {
  const objects = execFileSync('git', ['rev-list', '--objects', '--all'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ids = objects
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[0]);
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    input: ids.join('\n') + '\n',
    maxBuffer: 512 * 1024 * 1024,
  });
  let offset = 0;
  while (offset < batch.length) {
    const end = batch.indexOf(10, offset);
    if (end < 0) break;
    const [id, type, size] = batch.subarray(offset, end).toString().split(' ');
    offset = end + 1;
    const bytes = batch.subarray(offset, offset + Number(size));
    if (type === 'blob' || type === 'commit' || type === 'tag' || type === 'tree') scan(`object:${id}`, bytes);
    offset += Number(size) + 1;
  }
} else {
  const files = treeRoot
    ? walk(treeRoot)
    : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
  for (const file of files) {
    if (forbidden(file)) findings.push({ location: file, category: 'installation state' });
    const full = treeRoot ? path.join(treeRoot, file) : file;
    if (fs.existsSync(full) && fs.statSync(full).isFile())
      scan(file, Buffer.concat([Buffer.from(file + '\n'), fs.readFileSync(full)]));
  }
}
for (const finding of findings.slice(0, 100)) console.error(JSON.stringify(finding));
if (findings.length > 100) console.error(`${findings.length - 100} additional findings redacted.`);
console.log(
  JSON.stringify({
    mode: history ? 'all reachable Git objects' : treeRoot ? 'artifact' : 'working tree',
    checked,
    findings: findings.length,
    privateTerms: terms.length,
  }),
);
process.exitCode = findings.length ? 1 : 0;
