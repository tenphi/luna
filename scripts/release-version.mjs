#!/usr/bin/env node
// Version script for the Changesets release PR. `changeset version` bumps package.json and writes
// CHANGELOG.md; the shipped npm shrinkwrap names the package version too, so keep it in step.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

execFileSync('pnpm', ['exec', 'changeset', 'version'], { stdio: 'inherit' });
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const shrinkwrap = JSON.parse(fs.readFileSync('npm-shrinkwrap.json', 'utf8'));
shrinkwrap.version = version;
shrinkwrap.packages[''].version = version;
fs.writeFileSync('npm-shrinkwrap.json', `${JSON.stringify(shrinkwrap, null, 2)}\n`);
