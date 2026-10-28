/**
 * `luna redeploy` — one command to apply local changes end-to-end.
 *
 * The thing you run after editing host or agent-runner code so you don't have
 * to guess the sequence. By default it:
 *   1. rebuilds host TypeScript (`pnpm run build`)
 *   2. rebuilds the agent container image (`container/build.sh`)
 *   3. stops any running/stale agent containers (so the next message spawns a
 *      fresh one — a long-running Bun process never re-imports edited source)
 *   4. restarts the host service (launchd/systemd), which also sweeps orphans
 *
 * Narrow the build with --host-only / --container-only, or skip building
 * entirely with --no-build (just stop agents + restart the host).
 *
 *   luna redeploy
 *   luna redeploy --container-only
 *   luna redeploy --no-build
 */
import { runDevBuild } from '../../build/dev-build.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

register({
  name: 'redeploy',
  description: 'Rebuild host + container, stop stale agent containers, and restart the host service',
  access: 'open',
  parseArgs: (raw) => {
    const noBuild = raw['no-build'] === true;
    const hostOnly = raw['host-only'] === true;
    const containerOnly = raw['container-only'] === true;
    if (hostOnly && containerOnly) {
      throw new Error('Cannot use --host-only and --container-only together');
    }
    if (noBuild && (hostOnly || containerOnly)) {
      throw new Error('Cannot combine --no-build with --host-only/--container-only');
    }
    return {
      host: !noBuild && !containerOnly,
      container: !noBuild && !hostOnly,
    };
  },
  handler: async (args, _ctx: CallerContext) =>
    runDevBuild({
      host: args.host,
      container: args.container,
      stopAgents: true,
      restart: true,
    }),
});
