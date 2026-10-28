import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { installTestSessionClient, resetTestSessionClient } from './session/test-support.js';
import { formatMessagesWithMedia } from './formatter.js';
import {
  collectImageAttachments,
  inferImageMime,
  resolveStagedInboxPath,
} from './image-attachments.js';

let testWorkspace: string;
let prevWorkspaceEnv: string | undefined;

beforeEach(() => {
  installTestSessionClient();
  testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-inbox-'));
  prevWorkspaceEnv = process.env.LUNA_TEST_WORKSPACE;
  process.env.LUNA_TEST_WORKSPACE = testWorkspace;
});

afterEach(() => {
  if (prevWorkspaceEnv === undefined) delete process.env.LUNA_TEST_WORKSPACE;
  else process.env.LUNA_TEST_WORKSPACE = prevWorkspaceEnv;
  resetTestSessionClient();
  fs.rmSync(testWorkspace, { recursive: true, force: true });
});

describe('inferImageMime', () => {
  it('uses explicit mimeType when present', () => {
    expect(inferImageMime({ mimeType: 'image/png' })).toBe('image/png');
  });

  it('maps Telegram photo type to jpeg', () => {
    expect(inferImageMime({ type: 'photo' })).toBe('image/jpeg');
  });

  it('returns null for non-images', () => {
    expect(inferImageMime({ type: 'document', mimeType: 'application/pdf' })).toBeNull();
  });
});

describe('resolveStagedInboxPath', () => {
  it('accepts safe inbox-relative paths', () => {
    expect(resolveStagedInboxPath('inbox/msg-1/photo.jpg')).toBe(
      path.join(testWorkspace, 'inbox/msg-1/photo.jpg'),
    );
  });

  it('rejects traversal', () => {
    expect(resolveStagedInboxPath('inbox/../escape.jpg')).toBeNull();
  });
});

describe('collectImageAttachments', () => {
  function insertMessage(id: string, content: object) {
    installTestSessionClient().seedInbound({ id, kind: 'chat-sdk', content: JSON.stringify(content) });
  }

  it('collects staged images when files exist on disk', () => {
    const filePath = path.join(testWorkspace, 'inbox/msg-1/photo.jpg');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff]));

    insertMessage('m1', {
      text: 'product photo',
      attachments: [{ type: 'photo', localPath: 'inbox/msg-1/photo.jpg' }],
    });

    const images = collectImageAttachments([
      {
        id: 'm1',
        seq: 1,
        kind: 'chat-sdk',
        timestamp: new Date().toISOString(),
        status: 'pending',
        process_after: null,
        recurrence: null,
        tries: 0,
        trigger: 1,
        platform_id: null,
        channel_type: 'telegram',
        thread_id: null,
        content: JSON.stringify({
          text: 'product photo',
          attachments: [{ type: 'photo', localPath: 'inbox/msg-1/photo.jpg' }],
        }),
      },
    ]);

    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/jpeg');
    expect(images[0].path).toBe(filePath);
  });

  it('formatMessagesWithMedia gives staged images a path without duplicating them', () => {
    insertMessage('m1', {
      text: 'see this',
      attachments: [
        { type: 'photo', name: 'shot.jpg', localPath: 'inbox/msg-2/shot.jpg' },
        { type: 'document', name: 'readme.pdf', localPath: 'inbox/msg-2/readme.pdf' },
      ],
    });

    const { prompt } = formatMessagesWithMedia([
      {
        id: 'm1',
        seq: 1,
        kind: 'chat-sdk',
        timestamp: new Date().toISOString(),
        status: 'pending',
        process_after: null,
        recurrence: null,
        tries: 0,
        trigger: 1,
        platform_id: null,
        channel_type: 'telegram',
        thread_id: null,
        content: JSON.stringify({
          text: 'see this',
          attachments: [
            { type: 'photo', name: 'shot.jpg', localPath: 'inbox/msg-2/shot.jpg' },
            { type: 'document', name: 'readme.pdf', localPath: 'inbox/msg-2/readme.pdf' },
          ],
        }),
      },
    ]);

    expect(prompt).toContain('see this');
    expect(prompt).toContain('readme.pdf');
    // The image also rides along as a vision part, so the line exists purely to
    // hand the agent a path it can pass to attach_files — exactly once, and
    // marked as already shown so the model does not describe it twice.
    expect(prompt.split('/workspace/inbox/msg-2/shot.jpg').length - 1).toBe(1);
    expect(prompt).toContain('shown above');
  });
});
