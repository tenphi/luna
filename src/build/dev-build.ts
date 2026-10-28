/**
 * Dev rebuild — compile host TypeScript and rebuild the agent container image.
 * Used by `luna build` and available for setup/service callers.
 */
import { execSync, spawnSync } from 'child_process';
import path from 'path';

import { isPackagedInstall } from '../install-paths.js';
import { getDefaultContainerImage } from '../install-slug.js';
import { stopRunningAgentContainers } from '../container-runtime.js';
import { getServiceInfo, restartService } from '../service/host-service.js';

export interface DevBuildOptions {
  projectRoot?: string;
  /** Build host TypeScript (`pnpm run build`). Default true unless container-only. */
  host?: boolean;
  /** Rebuild agent container image (`container/build.sh`). Default true unless host-only. */
  container?: boolean;
  /** Restart the launchd/systemd service after a successful build. */
  restart?: boolean;
  /**
   * Stop running agent containers so the next inbound message spawns a fresh
   * one on the just-built image / edited (mounted) agent-runner source. A
   * long-running Bun process never re-imports edited files, so this is required
   * whenever agent-runner code changed. Defaults to whatever `restart` is.
   */
  stopAgents?: boolean;
}

export interface DevBuildResult {
  ok: boolean;
  host_ok?: boolean;
  container_ok?: boolean;
  image?: string;
  stopped_containers?: string[];
  service?: { state: string; pid: number | null; restarted: boolean };
}

function runHostBuild(projectRoot: string): void {
  execSync('pnpm run build', { cwd: projectRoot, stdio: 'inherit' });
}

function runContainerBuild(projectRoot: string): void {
  const script = path.join(projectRoot, 'container', 'build.sh');
  const res = spawnSync('bash', [script], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, CONTAINER_RUNTIME: 'container' },
  });
  if (res.status !== 0) {
    throw new Error(`container build failed (exit ${res.status ?? 'unknown'})`);
  }
}

export function runDevBuild(options: DevBuildOptions = {}): DevBuildResult {
  const projectRoot = options.projectRoot ?? process.cwd();
  const buildHost = options.host ?? true;
  const buildContainer = options.container ?? true;
  const image = getDefaultContainerImage(projectRoot);

  const result: DevBuildResult = { ok: false, image };

  // A packaged install ships its compiled host; only a source checkout rebuilds it.
  if (buildHost && !isPackagedInstall(projectRoot)) {
    runHostBuild(projectRoot);
    result.host_ok = true;
  }

  if (buildContainer) {
    runContainerBuild(projectRoot);
    result.container_ok = true;
  }

  result.ok = true;

  // Stop stale agent containers so fresh ones spawn with the new image/source.
  // Done directly (not just via the host's startup orphan sweep) so it also
  // works when the service isn't installed (e.g. `pnpm run dev`), and is
  // immediate rather than deferred to the next host boot.
  const stopAgents = options.stopAgents ?? options.restart ?? false;
  if (stopAgents) {
    result.stopped_containers = stopRunningAgentContainers('luna build/redeploy');
  }

  if (options.restart) {
    const info = getServiceInfo(projectRoot);
    if (info.state === 'not_installed') {
      result.service = { state: info.state, pid: null, restarted: false };
    } else {
      const after = restartService(projectRoot);
      result.service = {
        state: after.state,
        pid: after.pid,
        restarted: true,
      };
    }
  }

  return result;
}
