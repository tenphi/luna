/**
 * Command barrel — populates the registry before the CLI server starts.
 *
 * Resource definitions register their CRUD commands on import.
 * Help commands are registered after resources are loaded.
 */
import '../resources/index.js';
import { registerConfigHelpCommands } from '../config-help.js';
import '../approval-handler.js';
import { registerResourceHelpCommands } from './help.js';
import './system-prompt-stats.js';
import './status.js';
import './health.js';
import './doctor.js';
import './env.js';
import './agent-config.js';
import './restart.js';
import './channels.js';
import './db.js';
import './deliveries.js';
import './wire.js';
import './service.js';
import './build.js';
import './redeploy.js';

registerResourceHelpCommands();
registerConfigHelpCommands();
