import * as prompts from '@clack/prompts';
import color from 'kleur';

const ansi = Boolean(process.stdout.isTTY) && !Object.hasOwn(process.env, 'NO_COLOR');
const rgb = ansi && ['truecolor', '24bit'].includes(process.env.COLORTERM ?? '');
function paint(text: string, style: string, fallback: (text: string) => string): string {
  return !ansi ? text : rgb ? `\x1b[${style}m${text}\x1b[0m` : fallback(text);
}
export const brand = (text: string): string => paint(text, '38;2;184;142;211', color.magenta);
export const brandBold = (text: string): string => paint(text, '1;38;2;184;142;211', (value) => color.bold(color.magenta(value)));
export const brandChip = (text: string): string => paint(text, '1;48;2;184;142;211;38;2;32;25;40', (value) => color.bgMagenta(color.black(color.bold(value))));
export const accentGreen = (text: string): string => paint(text, '38;2;100;190;128', color.green);
export const brandBody = (text: string): string => text.split('\n').map((line) => line ? brand(line) : line).join('\n');
const width = (text: string): number => text.replace(/\x1b\[[\d;]*m/g, '').length;
export function fmtDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function fitToWidth(label: string, suffix: string): string {
  const available = Math.max(20, (process.stdout.columns || 80) - 7 - width(suffix));
  return width(label) <= available ? label : label.slice(0, available - 1) + '…';
}
export function wrapForGutter(text: string, gutter: number): string {
  const available = Math.max(30, (process.stdout.columns || 80) - gutter);
  return text.split('\n').map((line) => {
    if (width(line) <= available) return line;
    const output = [''];
    for (const word of line.split(' ')) {
      const current = output.at(-1)!;
      if (current && width(current) + 1 + width(word) > available) output.push(word);
      else output[output.length - 1] = current ? `${current} ${word}` : word;
    }
    return output.join('\n');
  }).join('\n');
}
export const dimWrap = (text: string, gutter: number): string => wrapForGutter(text, gutter);
export function note(message: string, title?: string): void { prompts.note(message, title, { format: brandBody }); }
