import { spawn } from 'node:child_process';
import * as prompts from '@clack/prompts';
import { ensureAnswer } from './runner.js';

export function openUrl(url: string): void {
  if (process.platform !== 'darwin') return;
  const processHandle = spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' });
  processHandle.once('error', () => {});
  processHandle.unref();
}

export const formatNoteLink = (url: string): string => `\n${url}`;

export async function confirmThenOpen(url: string, message = 'Open the setup page in your browser?'): Promise<void> {
  const accepted = ensureAnswer(await prompts.confirm({ message: `${message}\n${url}`, initialValue: true }));
  if (accepted) openUrl(url);
}
