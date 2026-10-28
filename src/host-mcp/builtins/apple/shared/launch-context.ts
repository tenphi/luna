/** True when running under launchd (or similar) without an interactive terminal parent. */
export function isLaunchdLikeSession(): boolean {
  if (process.env.LUNA_APPLE_FORCE_INTERACTIVE === '1') return false;
  // launchd jobs typically have no TERM; ppid 1 is launchd on macOS.
  return !process.env.TERM || process.ppid === 1;
}
