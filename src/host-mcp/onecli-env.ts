import fs from 'fs';

import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../config.js';
import { ensureHostMcpDataDirs, resolveOneCliCaPath } from './shared/paths.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

export async function buildHostOneCliEnv(agentGroupId: string): Promise<Record<string, string> | null> {
  try {
    await onecli.ensureAgent({ name: agentGroupId, identifier: agentGroupId });
    const cfg = await onecli.getContainerConfig(agentGroupId);
    ensureHostMcpDataDirs();
    const hostCaPath = resolveOneCliCaPath(agentGroupId);
    fs.writeFileSync(hostCaPath, cfg.caCertificate);
    return {
      ...cfg.env,
      SSL_CERT_FILE: hostCaPath,
      NODE_EXTRA_CA_CERTS: hostCaPath,
      DENO_CERT: hostCaPath,
    };
  } catch {
    return null;
  }
}
