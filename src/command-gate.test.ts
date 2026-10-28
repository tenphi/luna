import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LunaConfigDoc } from './config/schema.js';

/**
 * `var`, not `let`: `vi.mock` hoists above this declaration and modules in the import graph call
 * `loadLunaConfig()` at import time, which would hit a `let` binding's temporal dead zone.
 */
// eslint-disable-next-line no-var
var testConfig: LunaConfigDoc | undefined;
vi.mock('./config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/loader.js')>();
  return { ...actual, loadLunaConfig: () => testConfig ?? {} };
});

import { gateCommand } from './command-gate.js';
import { closeDb, createAgentGroup, initTestDb, initializeCentralSchema } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';

describe('gateCommand', () => {
  beforeEach(() => {
    const db = initTestDb();
    initializeCentralSchema(db);
    const now = new Date().toISOString();
    createAgentGroup({ id: 'ag-1', name: 'AG-1', agent_provider: null, created_at: now });
    // 42 is the configured owner; 99 is in the roster but not the owner.
    testConfig = {
      users: {
        ada: { name: 'Ada', telegramHandle: 'ownerhandle' },
        bo: { name: 'bo', telegramHandle: 'memberhandle' },
      },
      owner: 'ada',
    };
    createUser({
      id: 'telegram:42',
      kind: 'telegram',
      display_name: null,
      platform_username: 'ownerhandle',
      created_at: now,
    });
    createUser({
      id: 'telegram:99',
      kind: 'telegram',
      display_name: null,
      platform_username: 'memberhandle',
      created_at: now,
    });
  });

  afterEach(() => {
    closeDb();
  });

  it('passes owner commands for the local CLI identity, with no grant and no users row', () => {
    // `luna chat` prints the owner command set on the grounds that reaching data/cli.sock already
    // requires host access. The gate used to disagree, so every owner command it advertised came
    // back "requires owner access". Note there is deliberately no createUser/grantRole for
    // cli:local here — that is the state a fresh install is in.
    for (const command of ['/health', '/restart', '/usage', '/topics', '/tasks']) {
      expect(gateCommand(JSON.stringify({ text: command }), 'cli:local')).toEqual({
        action: 'pass',
        command,
      });
    }
  });

  it('still denies owner commands to an unidentified sender', () => {
    // The CLI exemption is one specific id, not a hole for a null sender.
    expect(gateCommand(JSON.stringify({ text: '/restart' }), null)).toEqual({
      action: 'deny',
      command: '/restart',
    });
  });

  it('owner-gates /usage@bot for non-owners', () => {
    const content = JSON.stringify({ text: '/usage@luna_bot' });
    expect(gateCommand(content, 'telegram:99')).toEqual({
      action: 'deny',
      command: '/usage',
    });
  });

  it('passes /usage@bot for owners', () => {
    const content = JSON.stringify({ text: '/usage@luna_bot' });
    expect(gateCommand(content, 'telegram:42')).toEqual({
      action: 'pass',
      command: '/usage',
    });
  });

  it('owner-gates /topics', () => {
    const content = JSON.stringify({ text: '/topics' });
    expect(gateCommand(content, 'telegram:99')).toEqual({ action: 'deny', command: '/topics' });
    expect(gateCommand(content, 'telegram:42')).toEqual({ action: 'pass', command: '/topics' });
  });

  it('owner-gates /tasks', () => {
    const content = JSON.stringify({ text: '/tasks' });
    expect(gateCommand(content, 'telegram:99')).toEqual({ action: 'deny', command: '/tasks' });
    expect(gateCommand(content, 'telegram:42')).toEqual({ action: 'pass', command: '/tasks' });
  });

  it('passes the memory reads for any participant, arguments and all', () => {
    // The gate matches the token only; the argument is read from the message body by whoever
    // handles it (see parseSlashCommand).
    expect(gateCommand(JSON.stringify({ text: '/read people/jane' }), 'telegram:99')).toEqual({
      action: 'pass',
      command: '/read',
    });
    expect(gateCommand(JSON.stringify({ text: '/list' }), 'telegram:99')).toEqual({
      action: 'pass',
      command: '/list',
    });
    expect(gateCommand(JSON.stringify({ text: '/recall@luna_bot where did I park' }), null)).toEqual({
      action: 'pass',
      command: '/recall',
    });
  });

  it('passes the memory corrections for any participant too', () => {
    // A shared agent's memory belongs to the household, and the person best placed to remove a
    // wrong sentence is whoever noticed it.
    for (const text of ['/forget fct_abc', '/undo']) {
      const command = text.split(' ')[0]!;
      expect(gateCommand(JSON.stringify({ text }), 'telegram:99')).toEqual({ action: 'pass', command });
    }
  });

  it('owner-gates /kill for non-owners', () => {
    const content = JSON.stringify({ text: '/kill' });
    expect(gateCommand(content, 'telegram:99')).toEqual({
      action: 'deny',
      command: '/kill',
    });
  });

  it('passes /kill for owners', () => {
    const content = JSON.stringify({ text: '/kill' });
    expect(gateCommand(content, 'telegram:42')).toEqual({
      action: 'pass',
      command: '/kill',
    });
  });

  it('owner-gates /restart for non-owners', () => {
    const content = JSON.stringify({ text: '/restart' });
    expect(gateCommand(content, 'telegram:99')).toEqual({
      action: 'deny',
      command: '/restart',
    });
  });

  it('passes /restart for owners', () => {
    const content = JSON.stringify({ text: '/restart' });
    expect(gateCommand(content, 'telegram:42')).toEqual({
      action: 'pass',
      command: '/restart',
    });
  });

  it('owner-gates /health for non-owners', () => {
    const content = JSON.stringify({ text: '/health' });
    expect(gateCommand(content, 'telegram:99')).toEqual({
      action: 'deny',
      command: '/health',
    });
  });

  it('passes /health for owners', () => {
    const content = JSON.stringify({ text: '/health@luna_bot' });
    expect(gateCommand(content, 'telegram:42')).toEqual({
      action: 'pass',
      command: '/health',
    });
  });

  it('passes /clear for non-owners', () => {
    const content = JSON.stringify({ text: '/clear' });
    expect(gateCommand(content, 'telegram:99')).toEqual({
      action: 'pass',
      command: '/clear',
    });
  });

  it('passes /learn for non-owners', () => {
    const content = JSON.stringify({ text: '/learn off' });
    expect(gateCommand(content, 'telegram:99')).toEqual({
      action: 'pass',
      command: '/learn',
    });
  });

  it('passes /stop for non-owners', () => {
    const content = JSON.stringify({ text: '/stop@luna_bot' });
    expect(gateCommand(content, 'telegram:99')).toEqual({
      action: 'pass',
      command: '/stop',
    });
  });

  it('answers /help from the host', () => {
    const content = JSON.stringify({ text: '/help' });
    expect(gateCommand(content, 'telegram:42')).toEqual({ action: 'help' });
  });

  it('answers /help even from an unidentified sender', () => {
    expect(gateCommand('/help', null)).toEqual({ action: 'help' });
  });

  it('rejects unknown slash commands', () => {
    const content = JSON.stringify({ text: '/foobar@luna_bot' });
    expect(gateCommand(content, 'telegram:42')).toEqual({
      action: 'unrecognized',
      command: '/foobar',
    });
  });

  it('passes non-command messages', () => {
    const content = JSON.stringify({ text: 'hello' });
    expect(gateCommand(content, 'telegram:42')).toEqual({ action: 'pass' });
  });
});
