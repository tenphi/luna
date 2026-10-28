import fs from 'fs';
import path from 'path';

import { getTheAgent } from '../../bootstrap.js';
import { CENTRAL_DB_PATH } from '../../config.js';
import { getActiveContainerCount } from '../../container-runner.js';
import { getChannelAdapter, getRegisteredChannelNames } from '../../channels/channel-registry.js';
import { readStoredContainerConfig } from '../../container-config.js';
import { getDb } from '../../db/connection.js';
import { readErrorLogSinceBoot } from '../../host-boot.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

register({
  name: 'status',
  description: 'Service health: agent, wired channels, containers, recent errors',
  access: 'open',
  parseArgs: () => ({}),
  handler: async (_args, _ctx: CallerContext) => {
    const dbOk = fs.existsSync(CENTRAL_DB_PATH);
    let sessions = 0;
    let agent: Record<string, unknown> | null = null;
    let wired_channels: Array<{ channel: string; platform_id: string; name: string | null }> = [];

    if (dbOk) {
      sessions = (getDb().prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'active'").get() as { c: number })
        .c;
      try {
        const ag = getTheAgent();
        const cfg = readStoredContainerConfig(ag);
        agent = {
          name: ag.name,
          model: cfg.model ?? null,
          provider: cfg.provider ?? null,
        };
        wired_channels = getDb()
          .prepare(
            `SELECT mg.channel_type AS channel, mg.platform_id, mg.name
             FROM messaging_group_agents mga
             JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
             WHERE mga.agent_group_id = ?
             ORDER BY mg.channel_type, mg.platform_id`,
          )
          .all(ag.id) as typeof wired_channels;
      } catch {
        agent = null;
      }
    }

    const channels = getRegisteredChannelNames().map((t) => ({
      type: t,
      registered: Boolean(getChannelAdapter(t)),
    }));
    const errorLog = path.join(process.cwd(), 'logs', 'luna.error.log');
    const recentErrors = readErrorLogSinceBoot(errorLog).slice(-5);

    return {
      database: { path: CENTRAL_DB_PATH, ok: dbOk, active_sessions: sessions },
      agent,
      wired_channels,
      containers: { active: getActiveContainerCount() },
      channel_adapters: channels,
      logs: { error_log: errorLog, recent_errors: recentErrors },
    };
  },
});
