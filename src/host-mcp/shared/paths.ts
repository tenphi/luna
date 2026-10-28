import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

export function resolveHostMcpDataDir(): string {
  return path.resolve(DATA_DIR, 'host-mcp');
}

export function resolveHostMcpTokensDir(): string {
  return path.join(resolveHostMcpDataDir(), 'tokens');
}

export function resolveHostMcpOneCliDir(): string {
  return path.join(resolveHostMcpDataDir(), 'onecli');
}

export function ensureHostMcpDataDirs(): void {
  fs.mkdirSync(resolveHostMcpDataDir(), { recursive: true });
  fs.mkdirSync(resolveHostMcpTokensDir(), { recursive: true });
  fs.mkdirSync(resolveHostMcpOneCliDir(), { recursive: true });
}

export function pairKey(agentGroupId: string, serverName: string): string {
  return `${agentGroupId}__${serverName}`;
}

export function resolvePairTokenPath(agentGroupId: string, serverName: string): string {
  return path.join(resolveHostMcpTokensDir(), `${pairKey(agentGroupId, serverName)}.token`);
}

export function resolveOneCliCaPath(agentGroupId: string): string {
  return path.join(resolveHostMcpOneCliDir(), `${agentGroupId}.pem`);
}
