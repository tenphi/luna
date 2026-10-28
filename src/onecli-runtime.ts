/**
 * Luna-owned OneCLI gateway runtime on Apple Container.
 *
 * Starts postgres + ghcr.io/onecli/onecli as detached containers on a private
 * install-scoped network. API on 127.0.0.1:10254; credential proxy on
 * 127.0.0.1:10255 (agent containers reach it via the OneCLI bridge).
 */
import { execFileSync, execSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, ONECLI_URL } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { getInstallSlug } from './install-slug.js';
import { log } from './log.js';

export const ONECLI_GATEWAY_VERSION = '1.35.1';
export const ONECLI_APP_PORT = 10254;
export const ONECLI_PROXY_PORT = 10255;
export const DEFAULT_ONECLI_URL = `http://127.0.0.1:${ONECLI_APP_PORT}`;

const POSTGRES_IMAGE = 'postgres:18-alpine';
const ONECLI_IMAGE = `ghcr.io/onecli/onecli:${ONECLI_GATEWAY_VERSION}`;

const RUNTIME_DIR = path.join(DATA_DIR, 'onecli');
const RUNTIME_CONFIG_PATH = path.join(RUNTIME_DIR, 'runtime.json');

interface OneCliRuntimeConfig {
  postgresUser: string;
  postgresPassword: string;
  postgresDb: string;
}

interface ContainerListEntry {
  status: string;
  configuration: { id: string };
}

function slug(): string {
  return getInstallSlug();
}

function networkName(): string {
  return `luna-onecli-net-${slug()}`;
}

/**
 * Network that Luna-spawned containers (agent sessions)
 * must join to reach the host (Session API, host MCP
 * bridge) and the local OneCLI gateway. Apple Container's implicit `default`
 * network is not guaranteed to route to the host bridge — when a second network
 * exists the default lands on a separate subnet whose gateway the container
 * cannot reach — so spawns pin this network explicitly. Returns null when no
 * local gateway is managed or the network hasn't been created yet.
 */
export function hostReachableNetwork(): string | null {
  if (!shouldManageLocalOneCli()) return null;
  const net = networkName();
  return networkExists(net) ? net : null;
}

function postgresContainerName(): string {
  return `luna-onecli-postgres-${slug()}`;
}

function gatewayContainerName(): string {
  return `luna-onecli-gateway-${slug()}`;
}

function pgVolumeName(): string {
  return `luna-onecli-pgdata-${slug()}`;
}

function appDataHostPath(): string {
  const dir = path.join(RUNTIME_DIR, 'app-data');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o777);
  } catch {
    // Best effort — bind mount must be writable by the gateway's node user.
  }
  return dir;
}

function containerIpv4(name: string): string | null {
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} inspect ${name}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out) as Array<{ networks?: Array<{ ipv4Address?: string }> }>;
    const addr = parsed[0]?.networks?.[0]?.ipv4Address;
    if (!addr) return null;
    return addr.split('/')[0] ?? null;
  } catch {
    return null;
  }
}

function removeContainerIfStopped(name: string): void {
  if (!containerExists(name) || containerRunning(name)) return;
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} rm ${name}`, { stdio: 'pipe' });
    log.info('Removed stopped OneCLI container for recreate', { name });
  } catch (err) {
    log.warn('Failed to remove stopped OneCLI container', { name, err });
  }
}

/** True when ONECLI_URL points at a local gateway (not a remote vault). */
export function isLocalOnecliUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function shouldManageLocalOneCli(): boolean {
  if (!ONECLI_URL) return true;
  return isLocalOnecliUrl(ONECLI_URL);
}

let pendingGatewayRecreate = false;

function persistRuntimeConfig(cfg: OneCliRuntimeConfig): void {
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

function loadRuntimeConfig(): OneCliRuntimeConfig {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8')) as Partial<
      OneCliRuntimeConfig & { nextAuthSecret?: string }
    >;
    const cfg: OneCliRuntimeConfig = {
      postgresUser: raw.postgresUser ?? 'onecli',
      postgresPassword: raw.postgresPassword ?? crypto.randomBytes(24).toString('hex'),
      postgresDb: raw.postgresDb ?? 'onecli',
    };
    if (raw.nextAuthSecret) {
      // Legacy installs set NEXTAUTH_SECRET, which enables OAuth and breaks headless
      // `onecli secrets create` during setup. Single-user mode omits it entirely.
      pendingGatewayRecreate = true;
      persistRuntimeConfig(cfg);
    }
    return cfg;
  }
  const cfg: OneCliRuntimeConfig = {
    postgresUser: 'onecli',
    postgresPassword: crypto.randomBytes(24).toString('hex'),
    postgresDb: 'onecli',
  };
  persistRuntimeConfig(cfg);
  return cfg;
}

function gatewayImageReference(name: string): string | null {
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} inspect ${name}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out) as Array<{ configuration?: { image?: { reference?: string } } }>;
    return parsed[0]?.configuration?.image?.reference ?? null;
  } catch {
    return null;
  }
}

function recreateGatewayIfNeeded(): void {
  const name = gatewayContainerName();
  const imageRef = gatewayImageReference(name);
  const versionMismatch = imageRef != null && !imageRef.includes(`onecli:${ONECLI_GATEWAY_VERSION}`);
  if (!pendingGatewayRecreate && !versionMismatch) return;
  pendingGatewayRecreate = false;
  if (!containerExists(name)) return;
  log.info('Recreating OneCLI gateway container', { name, imageRef, target: ONECLI_IMAGE });
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
  } catch {
    // already stopped
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} rm ${name}`, { stdio: 'pipe' });
  } catch (err) {
    log.warn('Failed to remove OneCLI gateway for recreate', { name, err });
  }
}

function runContainer(args: string[]): void {
  const res = spawnSync(CONTAINER_RUNTIME_BIN, args, { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`${CONTAINER_RUNTIME_BIN} ${args.join(' ')} failed: ${res.stderr || res.stdout || res.status}`);
  }
}

function containerExists(name: string): boolean {
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} ls --all --format json`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const list = JSON.parse(out || '[]') as ContainerListEntry[];
    return list.some((c) => c.configuration.id === name);
  } catch {
    return false;
  }
}

function containerRunning(name: string): boolean {
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const list = JSON.parse(out || '[]') as ContainerListEntry[];
    return list.some((c) => c.configuration.id === name && c.status === 'running');
  } catch {
    return false;
  }
}

function networkExists(name: string): boolean {
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} network inspect ${name}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out || '[]') as unknown;
    if (Array.isArray(parsed)) return parsed.length > 0;
    return parsed != null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function ensureNetwork(): void {
  const net = networkName();
  if (networkExists(net)) return;
  log.info('Creating OneCLI network', { net });
  runContainer(['network', 'create', net]);
}

function ensureVolume(name: string): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} volume inspect ${name}`, { stdio: 'pipe' });
  } catch {
    log.info('Creating OneCLI volume', { name });
    runContainer(['volume', 'create', name]);
  }
}

function startPostgres(cfg: OneCliRuntimeConfig): void {
  const name = postgresContainerName();
  if (containerRunning(name)) return;

  if (containerExists(name)) {
    log.info('Starting existing OneCLI postgres container', { name });
    runContainer(['start', name]);
    return;
  }

  ensureNetwork();
  ensureVolume(pgVolumeName());

  log.info('Starting OneCLI postgres container', { name });
  runContainer([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    networkName(),
    '-e',
    `POSTGRES_USER=${cfg.postgresUser}`,
    '-e',
    `POSTGRES_PASSWORD=${cfg.postgresPassword}`,
    '-e',
    `POSTGRES_DB=${cfg.postgresDb}`,
    '-v',
    `${pgVolumeName()}:/var/lib/postgresql`,
    POSTGRES_IMAGE,
  ]);
}

function startGateway(cfg: OneCliRuntimeConfig): void {
  const name = gatewayContainerName();
  recreateGatewayIfNeeded();
  if (containerRunning(name)) return;

  removeContainerIfStopped(name);
  if (containerRunning(name)) return;

  ensureNetwork();
  const pgName = postgresContainerName();
  const pgIp = containerIpv4(pgName);
  if (!pgIp) {
    throw new Error(`OneCLI postgres has no network address (${pgName})`);
  }

  const bindHost = '127.0.0.1';
  const appDataDir = appDataHostPath();
  const databaseUrl = `postgresql://${cfg.postgresUser}:${cfg.postgresPassword}@${pgIp}:5432/${cfg.postgresDb}`;
  const appUrl = `http://${bindHost}:${ONECLI_APP_PORT}`;
  const gatewayApiUrl = `http://${bindHost}:${ONECLI_PROXY_PORT}`;

  log.info('Starting OneCLI gateway container', { name, image: ONECLI_IMAGE });
  runContainer([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    networkName(),
    '-p',
    `${bindHost}:${ONECLI_APP_PORT}:${ONECLI_APP_PORT}`,
    '-p',
    `${bindHost}:${ONECLI_PROXY_PORT}:${ONECLI_PROXY_PORT}`,
    '-e',
    `DATABASE_URL=${databaseUrl}`,
    '-e',
    `APP_URL=${appUrl}`,
    '-e',
    `GATEWAY_API_URL=${gatewayApiUrl}`,
    '-v',
    `${appDataDir}:/app/data`,
    ONECLI_IMAGE,
  ]);
}

async function waitForPostgres(timeoutMs: number): Promise<boolean> {
  const name = postgresContainerName();
  const cfg = loadRuntimeConfig();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!containerRunning(name)) return false;
    try {
      execFileSync(CONTAINER_RUNTIME_BIN, ['exec', name, 'pg_isready', '-U', cfg.postgresUser], { stdio: 'pipe' });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

export async function pollOneCliHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export interface EnsureOneCliResult {
  url: string;
  healthy: boolean;
}

/** Idempotently ensure local OneCLI gateway containers are running. */
export async function ensureOneCliRuntime(): Promise<EnsureOneCliResult> {
  const cfg = loadRuntimeConfig();
  startPostgres(cfg);
  const pgReady = await waitForPostgres(60_000);
  if (!pgReady) {
    throw new Error('OneCLI postgres did not become ready within 60s');
  }
  startGateway(cfg);
  const url = DEFAULT_ONECLI_URL;
  const healthy = await pollOneCliHealth(url, 90_000);
  return { url, healthy };
}
