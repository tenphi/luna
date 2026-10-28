import fs from 'fs';

import type { ImageAttachment } from '../../image-attachments.js';
import type { ChatMessage, ContentPart } from './types.js';

/** Build multimodal user content when staged images are present. */
export function buildUserContent(prompt: string, images?: ImageAttachment[]): string | ContentPart[] {
  if (!images?.length) return prompt;

  const parts: ContentPart[] = [{ type: 'text', text: prompt }];
  for (const img of images) {
    try {
      const data = fs.readFileSync(img.path);
      const b64 = data.toString('base64');
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${b64}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[openai-provider] Failed to read image ${img.path}: ${message}`);
    }
  }

  if (parts.length === 1) return prompt;
  return parts;
}

/** Drop image_url parts before persisting history — base64 blobs bloat session files. */
export function stripImagePartsForPersistence(history: ChatMessage[]): ChatMessage[] {
  return history.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const text = msg.content
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n\n');
    return { ...msg, content: text || null };
  });
}
