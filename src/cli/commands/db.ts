import fs from 'fs';

import { CENTRAL_DB_PATH } from '../../config.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

register({
  name: 'db-reset',
  description: 'Delete the central database (dev only — all routing state is lost)',
  access: 'open',
  parseArgs: (raw) => ({
    confirm: raw.confirm === true || raw.confirm === 'true',
  }),
  handler: async (args, _ctx: CallerContext) => {
    if (!args.confirm) {
      throw new Error('Pass --confirm true to delete data/luna.db');
    }
    if (fs.existsSync(CENTRAL_DB_PATH)) {
      fs.unlinkSync(CENTRAL_DB_PATH);
    }
    return { deleted: CENTRAL_DB_PATH, hint: 'Restart Luna to recreate schema via migrations' };
  },
});
