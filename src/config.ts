import path from 'path';

import { loadLunaConfig, resolveSecretOrValue } from './config/loader.js';
import { getCentralDbPath, getSessionsDir } from './data-paths.js';
import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

export { getAgentDir, getMountAllowlistPath } from './install-paths.js';

const unified = loadLunaConfig();
const envConfig = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY', 'TZ']);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();

export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const CENTRAL_DB_PATH = getCentralDbPath(DATA_DIR);
export const SESSIONS_DIR = getSessionsDir(DATA_DIR);

// Image names are scoped to the installation path.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Cleanup identifies containers through this installation label.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `luna-install=${INSTALL_SLUG}`;
export const ONECLI_URL = process.env.ONECLI_URL || unified.install?.onecli?.url || envConfig.ONECLI_URL || undefined;
export const ONECLI_API_KEY =
  process.env.ONECLI_API_KEY || resolveSecretOrValue(unified.install?.onecli?.apiKey) || envConfig.ONECLI_API_KEY;

// Prefer the first valid timezone from the configured sources.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    unified.install?.timezone,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
