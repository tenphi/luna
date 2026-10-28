/**
 * `luna service` — install and control the host launchd/systemd unit.
 *
 *   luna service status
 *   luna service start
 *   luna service stop
 *   luna service restart
 *   luna service install   (build + write plist/unit + load)
 */
import {
  getServiceInfo,
  installService,
  restartService,
  startService,
  stopService,
} from '../../service/host-service.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

function registerServiceVerb(
  verb: string,
  description: string,
  run: (projectRoot: string) => unknown | Promise<unknown>,
): void {
  register({
    name: `service-${verb}`,
    description,
    access: 'open',
    parseArgs: () => ({}),
    handler: async (_args, _ctx: CallerContext) => run(process.cwd()),
  });
}

registerServiceVerb('status', 'Show launchd/systemd service state for this install', () => {
  const info = getServiceInfo();
  return {
    manager: info.manager,
    label: info.label,
    state: info.state,
    pid: info.pid,
    plist_path: info.plist_path,
    unit: info.unit,
    project_root: info.project_root,
  };
});

registerServiceVerb('start', 'Start the Luna host service', () => {
  const after = startService();
  return { state: after.state, pid: after.pid, label: after.label };
});

registerServiceVerb('stop', 'Stop the Luna host service', () => {
  const after = stopService();
  return { state: after.state, label: after.label };
});

registerServiceVerb('restart', 'Restart the Luna host service (reload host process)', () => {
  const after = restartService();
  return { state: after.state, pid: after.pid, label: after.label };
});

registerServiceVerb('install', 'Install or refresh the service unit (runs setup service step)', () => {
  return installService();
});
