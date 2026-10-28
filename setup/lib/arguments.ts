export function optionValue(arguments_: string[], flag: string): string | undefined {
  const explicit = arguments_.find((value) => value.startsWith(`${flag}=`));
  if (explicit !== undefined) return explicit.slice(flag.length + 1);
  const position = arguments_.indexOf(flag);
  return position < 0 ? undefined : arguments_[position + 1];
}
export function requireOption(arguments_: string[], flag: string): string {
  const value = optionValue(arguments_, flag);
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
