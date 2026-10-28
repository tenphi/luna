/**
 * `luna build` — rebuild host + container for local development.
 *
 *   luna build
 *   luna build --host-only
 *   luna build --container-only
 *   luna build --restart
 */
import { runDevBuild } from '../../build/dev-build.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

register({
  name: 'build',
  description: 'Rebuild host TypeScript and agent container image for development',
  access: 'open',
  parseArgs: (raw) => {
    const hostOnly = raw['host-only'] === true;
    const containerOnly = raw['container-only'] === true;
    if (hostOnly && containerOnly) {
      throw new Error('Cannot use --host-only and --container-only together');
    }
    return {
      host: !containerOnly,
      container: !hostOnly,
      restart: raw.restart === true,
    };
  },
  handler: async (args, _ctx: CallerContext) =>
    runDevBuild({
      host: args.host,
      container: args.container,
      restart: args.restart,
    }),
});
