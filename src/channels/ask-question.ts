export type OptionInput = { label: string; selectedLabel?: string; value?: string };
export type RawOption = string | OptionInput;
export type NormalizedOption = { label: string; value: string; selectedLabel: string };

export function normalizeOption(option: RawOption): NormalizedOption {
  const input = typeof option === 'string' ? { label: option } : option;
  return Object.assign({ value: input.label, selectedLabel: input.label }, input, {
    value: input.value ?? input.label,
    selectedLabel: input.selectedLabel ?? input.label,
  });
}

export const normalizeOptions = (options: RawOption[]): NormalizedOption[] =>
  options.map((option) => normalizeOption(option));
