import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildUserContent, stripImagePartsForPersistence } from './vision.js';
import type { ChatMessage } from './types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-vision-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildUserContent', () => {
  it('returns plain text when no images', () => {
    expect(buildUserContent('hello')).toBe('hello');
  });

  it('adds image_url parts for staged files', () => {
    const imgPath = path.join(tmpDir, 'x.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const content = buildUserContent('photo', [{ path: imgPath, mimeType: 'image/png' }]);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'text')).toBe(true);
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });
});

describe('stripImagePartsForPersistence', () => {
  it('collapses multimodal user messages to text only', () => {
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ];
    const stripped = stripImagePartsForPersistence(history);
    expect(stripped[0].content).toBe('see image');
  });
});
