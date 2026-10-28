import './core.js';
import './scheduling.js';
import './skills.js';
import { startMcpServer } from './server.js';

void startMcpServer().catch((error) => {
  console.error('[mcp-tools] Server startup failed', error);
  process.exit(1);
});
