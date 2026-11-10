import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, CENTRAL_DB_PATH } from '../../config.js';
import { getRegisteredChannelNames } from '../../channels/channel-registry.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

register({
  name: 'doctor',
  description: 'Run install health checks (DB, container image, env, channels)',
  access: 'open',
  parseArgs: () => ({}),
  handler: async (_args, _ctx: CallerContext) => {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    checks.push({
      name: 'central_db',
      ok: fs.existsSync(CENTRAL_DB_PATH),
      detail: CENTRAL_DB_PATH,
    });

    const envPath = path.join(process.cwd(), '.env');
    checks.push({
      name: 'env_file',
      ok: fs.existsSync(envPath),
      detail: envPath,
    });

    let imageOk: boolean;
    try {
      const { execFileSync } = await import('child_process');
      execFileSync('container', ['image', 'inspect', CONTAINER_IMAGE], { stdio: 'ignore' });
      imageOk = true;
    } catch {
      imageOk = false;
    }
    checks.push({
      name: 'container_image',
      ok: imageOk,
      detail: CONTAINER_IMAGE,
    });

    const channels = getRegisteredChannelNames();
    checks.push({
      name: 'channels_registered',
      ok: channels.length > 0,
      detail: channels.join(', ') || '(none)',
    });

    const ok = checks.every((c) => c.ok);
    return { ok, checks };
  },
});
