/** Filenames and message IDs must be single path components before host file access. */
export function isSafeAttachmentName(value: string): boolean {
  const sentinels = new Set(['', '.', '..']);
  return (
    typeof value === 'string' &&
    !sentinels.has(value) &&
    !Array.from(value).some((character) => [0, 47, 92].includes(character.charCodeAt(0)))
  );
}
