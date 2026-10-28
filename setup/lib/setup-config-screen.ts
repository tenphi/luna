import * as prompts from '@clack/prompts';
import { ensureAnswer } from './runner.js';
import { CONFIG, type Entry } from './setup-config.js';
import type { ConfigValues } from './setup-config-parse.js';

async function edit(entry: Entry, values: ConfigValues): Promise<void> {
  const current = values[entry.key] ?? entry.default;
  if (entry.type === 'boolean') {
    values[entry.key] = ensureAnswer(await prompts.confirm({ message: entry.label, initialValue: Boolean(current) }));
    return;
  }
  if (entry.type === 'enum') {
    const choice = ensureAnswer(
      await prompts.select({
        message: entry.label,
        options: [{ value: '', label: 'Keep the current setting' }, ...entry.options],
      }),
    );
    if (choice) values[entry.key] = choice;
    return;
  }
  const validate = (input: string | undefined): string | undefined => {
    const text = input?.trim();
    if (!text) return;
    if (entry.type !== 'integer') return entry.validate?.(text);
    const value = Number(text);
    if (!Number.isInteger(value)) return 'Enter a whole number';
    if (entry.min !== undefined && value < entry.min) return `Minimum: ${entry.min}`;
    if (entry.max !== undefined && value > entry.max) return `Maximum: ${entry.max}`;
  };
  const message = `${entry.label} (blank keeps the current setting)`;
  const value = ensureAnswer(
    entry.secret
      ? await prompts.password({ message, validate })
      : await prompts.text({ message, validate, placeholder: current === undefined ? undefined : String(current) }),
  ).trim();
  if (value) values[entry.key] = entry.type === 'integer' ? Number(value) : value;
}
export async function runAdvancedScreen(initial: ConfigValues): Promise<ConfigValues> {
  const values = { ...initial };
  const settings = CONFIG.filter((entry) => entry.surface === 'flag+ui');
  for (;;) {
    const key = ensureAnswer(
      await prompts.select({
        message: 'Optional settings',
        initialValue: '',
        options: [
          { value: '', label: 'Continue setup' },
          ...settings.map((entry) => ({
            value: entry.key,
            label: entry.label,
            hint:
              entry.secret && values[entry.key] !== undefined ? 'configured' : String(values[entry.key] ?? 'default'),
          })),
        ],
      }),
    );
    if (!key) return values;
    const entry = settings.find((setting) => setting.key === key);
    if (entry) await edit(entry, values);
  }
}
