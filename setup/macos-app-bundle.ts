/** Re-export — implementation lives under src/ so the host can call it at runtime. */
export {
  ensureAppBundle,
  ensureCalendarHelperEmbedded,
  ensureLaunchdHostProgram,
  ensureLaunchdPlistUsesAppBundle,
  getAppBundleExecutable,
  getAppBundleId,
  getAppBundleName,
  getAppBundlePath,
  launchdHostProgramArgumentsXml,
} from '../src/host-mcp/builtins/apple/shared/app-bundle.js';
