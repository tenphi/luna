import path from 'path';

/** Resolve config dir for the current working directory (setup/tests may chdir). */
export function configDir(): string {
  return path.resolve(process.cwd(), 'config');
}

export function defaultConfigPath(): string {
  return path.join(configDir(), 'default.jsonc');
}

export function localConfigPath(): string {
  return path.join(configDir(), 'local.jsonc');
}
