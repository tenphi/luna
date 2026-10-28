import { collectHealthReport } from '../../health-report.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

register({
  name: 'health',
  description: 'Install health: models, memory, DB, builtins, OneCLI, runtime',
  access: 'open',
  parseArgs: () => ({}),
  handler: async (_args, _ctx: CallerContext) => {
    return collectHealthReport();
  },
});
