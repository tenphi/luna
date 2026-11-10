#!/usr/bin/env node
// Publish script for the Changesets release action. It publishes the tarball the release job
// already verified, instead of letting Changesets pack the checkout again, then has Changesets tag
// the version. The action pushes that tag and creates the GitHub release from what `changeset
// git-tag` reports through CHANGESETS_OUTPUT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const { name, version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));

function published() {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { stdio: 'pipe' });
    return true;
  } catch (error) {
    // npm prints its error as JSON on stdout; only a missing version means "not yet published".
    if (/"code":\s*"E404"/.test(String(error.stdout))) return false;
    throw error;
  }
}

if (published()) {
  console.log(`${name}@${version} is already on npm.`);
} else {
  const tarball = process.env.LUNA_RELEASE_TARBALL;
  assert(tarball && fs.existsSync(tarball), 'LUNA_RELEASE_TARBALL must name the verified release tarball');
  const manifest = JSON.parse(execFileSync('tar', ['xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(manifest.name, name, 'The verified tarball is a different package');
  assert.equal(manifest.version, version, 'The verified tarball is a different version');
  // npm exchanges the workflow's OIDC identity for a short-lived publish credential.
  execFileSync('npm', ['publish', tarball, '--access', 'public', '--provenance'], { stdio: 'inherit' });
}

// Skips a version that is already tagged, so reruns and pushes without a release are no-ops.
execFileSync('pnpm', ['exec', 'changeset', 'git-tag'], { stdio: 'inherit' });
