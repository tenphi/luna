import { describe, expect, it } from 'vitest';
import { renderAgentGroupDockerfile } from './container-image-build.js';

const BASE = 'luna-agent-abc:latest';

describe('renderAgentGroupDockerfile', () => {
  it('brackets the installs with root then drops back to node', () => {
    const out = renderAgentGroupDockerfile(BASE, ['imagemagick'], []);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe(`FROM ${BASE}`);
    expect(lines[1]).toBe('USER root');
    expect(lines.at(-1)).toBe('USER node');
    expect(out.indexOf('USER root')).toBeLessThan(out.indexOf('apt-get'));
    expect(out.indexOf('apt-get')).toBeLessThan(out.indexOf('USER node'));
  });

  it('renders apt installs and cleans the lists', () => {
    const out = renderAgentGroupDockerfile(BASE, ['imagemagick', 'ffmpeg'], []);
    expect(out).toContain('RUN apt-get update && apt-get install -y imagemagick ffmpeg');
    expect(out).toContain('rm -rf /var/lib/apt/lists/*');
  });

  it('routes registry packages to pnpm with a build-script allowlist', () => {
    const out = renderAgentGroupDockerfile(BASE, [], ['prettier', '@scope/pkg@1.2.3']);
    expect(out).toContain("echo 'only-built-dependencies[]=prettier' >> /root/.npmrc");
    expect(out).toContain("echo 'only-built-dependencies[]=@scope/pkg@1.2.3' >> /root/.npmrc");
    expect(out).toContain('pnpm install -g prettier @scope/pkg@1.2.3');
    expect(out).not.toContain('bun install -g');
  });

  it('routes github: specs to bun and symlinks their bins', () => {
    const out = renderAgentGroupDockerfile(BASE, [], ['github:someone/some-tool#5008b287']);
    expect(out).toContain('bun install -g github:someone/some-tool#5008b287');
    expect(out).toContain('ln -sf "$f" /usr/local/bin/');
    expect(out).not.toContain('pnpm install -g');
  });

  it('handles a mixed list', () => {
    const out = renderAgentGroupDockerfile(BASE, ['jq'], ['prettier', 'github:owner/repo']);
    expect(out).toContain('apt-get install -y jq');
    expect(out).toContain('pnpm install -g prettier');
    expect(out).toContain('bun install -g github:owner/repo');
  });

  it('emits only FROM/USER when both lists are empty', () => {
    expect(renderAgentGroupDockerfile(BASE, [], [])).toBe(`FROM ${BASE}\nUSER root\nUSER node\n`);
  });

  // The whole point of validating here: these lists can arrive from a
  // hand-edited container.json that never passed through the CLI.
  it('refuses a poisoned apt spec before rendering anything', () => {
    expect(() => renderAgentGroupDockerfile(BASE, ['imagemagick', 'foo && curl x | sh'], [])).toThrow(
      /Invalid apt package spec/,
    );
  });

  it('refuses an npm spec that would break out of the .npmrc single quotes', () => {
    expect(() => renderAgentGroupDockerfile(BASE, [], ["pkg' >> /root/.bashrc #"])).toThrow(/Invalid npm package spec/);
  });

  it('never emits a shell metacharacter beyond the ones it composes itself', () => {
    const out = renderAgentGroupDockerfile(BASE, ['imagemagick', 'ffmpeg=7:5.1.6-0+deb12u1'], ['prettier']);
    // No command substitution, no backgrounding, no redirect into an unexpected path.
    expect(out).not.toMatch(/\$\(/);
    expect(out).not.toMatch(/`/);
    expect(out).not.toMatch(/;/);
  });
});
