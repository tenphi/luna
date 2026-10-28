import crypto from 'crypto';
import fs from 'fs';

import { ensureHostMcpDataDirs, resolvePairTokenPath } from './shared/paths.js';

export function readOrCreatePairToken(agentGroupId: string, serverName: string): string {
  ensureHostMcpDataDirs();
  const tokenPath = resolvePairTokenPath(agentGroupId, serverName);
  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (existing) return existing;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  return token;
}
