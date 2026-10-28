import type {
  AdditionalMountDoc,
  AgentConfigDoc,
  LunaConfigDoc,
  AppleAppDoc,
  AppleConfigDoc,
  EmailConfigDoc,
  McpServerConfigDoc,
  ModelRole,
  ModelRoleConfig,
  ModelsConfig,
  NamedProviderConfig,
  ProvidersConfig,
  UserConfigDoc,
} from './schema.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mountKey(m: AdditionalMountDoc): string {
  return `${m.hostPath}::${m.containerPath}`;
}

function mergeKeyedRecord<T extends object>(
  base: Record<string, T> | undefined,
  overlay: Record<string, T> | undefined,
): Record<string, T> {
  const out: Record<string, T> = { ...(base ?? {}) };
  if (!overlay) return out;
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null || value === undefined) {
      delete out[key];
      continue;
    }
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = { ...existing, ...value } as T;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeMounts(
  base: AdditionalMountDoc[] | undefined,
  overlay: AdditionalMountDoc[] | undefined,
): AdditionalMountDoc[] {
  const map = new Map<string, AdditionalMountDoc>();
  for (const m of base ?? []) map.set(mountKey(m), m);
  for (const m of overlay ?? []) map.set(mountKey(m), { ...map.get(mountKey(m)), ...m });
  return [...map.values()];
}

function mergeStringArrays(base: string[] | undefined, overlay: string[] | undefined): string[] | undefined {
  if (overlay === undefined) return base;
  return [...overlay];
}

function mergeProviders(
  base: ProvidersConfig | undefined,
  overlay: ProvidersConfig | undefined,
): ProvidersConfig | undefined {
  if (!overlay) return base;
  if (!base) return { ...overlay };
  return mergeKeyedRecord<NamedProviderConfig>(
    base as Record<string, NamedProviderConfig>,
    overlay as Record<string, NamedProviderConfig>,
  );
}

function mergeModelRole(
  base: ModelRoleConfig | undefined,
  overlay: ModelRoleConfig | undefined,
): ModelRoleConfig | undefined {
  if (!base) return overlay ? { ...overlay } : undefined;
  if (!overlay) return { ...base };
  return { ...base, ...overlay };
}

/**
 * Merge every role present in either layer, rather than a hardcoded list.
 *
 * An enumerated list silently drops a newly-added role: the key parses fine, is
 * typed fine, and vanishes here — so the role resolves to its fallback and the
 * only symptom is that the config appears to have no effect. Iterating the union
 * of keys means adding a role to `ModelsConfig` is all it takes.
 */
function mergeModels(base: LunaConfigDoc['models'], layer: LunaConfigDoc['models']): LunaConfigDoc['models'] {
  if (!layer) return base;
  if (!base) return { ...layer };

  // The union of both layers' keys, which is what the paragraph above promises and what this did
  // not do: it named `main` and nothing else, so `ModelsConfig` and `mergeModelRole` were imported
  // for a version of this function that was not here. Only one role exists today, so the behaviour
  // is unchanged — the point is that adding a second one no longer needs a second edit here, and
  // forgetting that edit has no symptom beyond "the config appears to do nothing".
  const out: ModelsConfig = { ...base };
  for (const role of new Set([...Object.keys(base), ...Object.keys(layer)]) as Set<ModelRole>) {
    const merged = mergeModelRole(base[role], layer[role]);
    if (merged) out[role] = merged;
  }
  return out;
}

export function mergeAgent(base: AgentConfigDoc | undefined, overlay: AgentConfigDoc | undefined): AgentConfigDoc {
  if (!base) return { ...(overlay ?? {}) };
  if (!overlay) return { ...base };

  const basePackages = base.packages ?? { apt: [], npm: [] };
  const overlayPackages = overlay.packages;

  return {
    ...base,
    ...overlay,
    packages: overlayPackages
      ? {
          apt: overlayPackages.apt ?? basePackages.apt ?? [],
          npm: overlayPackages.npm ?? basePackages.npm ?? [],
        }
      : basePackages,
    mcpServers: mergeKeyedRecord<McpServerConfigDoc>(base.mcpServers, overlay.mcpServers),
    additionalMounts: mergeMounts(base.additionalMounts, overlay.additionalMounts),
    skillsDisabled: mergeStringArrays(base.skillsDisabled, overlay.skillsDisabled),
    skillsEnabled: mergeStringArrays(base.skillsEnabled, overlay.skillsEnabled),
    context: overlay.context ? { ...base.context, ...overlay.context } : base.context,
  };
}

function mergeAppleApp(base: AppleAppDoc | undefined, overlay: AppleAppDoc | undefined): AppleAppDoc {
  if (!base) return { ...(overlay ?? {}) };
  if (!overlay) return { ...base };
  return { ...base, ...overlay };
}

export function mergeApple(base: AppleConfigDoc | undefined, overlay: AppleConfigDoc | undefined): AppleConfigDoc {
  if (!base) return { ...(overlay ?? {}) };
  if (!overlay) return { ...base };
  return {
    ...base,
    ...overlay,
    apps: {
      calendar: mergeAppleApp(base.apps?.calendar, overlay.apps?.calendar),
      reminders: mergeAppleApp(base.apps?.reminders, overlay.apps?.reminders),
      notes: mergeAppleApp(base.apps?.notes, overlay.apps?.notes),
      messages: mergeAppleApp(base.apps?.messages, overlay.apps?.messages),
      contacts: mergeAppleApp(base.apps?.contacts, overlay.apps?.contacts),
    },
  };
}

/**
 * The email section is flat now — mailboxes live on `users.<key>.email` and merge with the roster.
 * `toolsAllow` is replaced rather than unioned: an overlay that narrows what the agent may do must
 * not have the default set merged back into it.
 */
export function mergeEmail(base: EmailConfigDoc | undefined, overlay: EmailConfigDoc | undefined): EmailConfigDoc {
  if (!base) return { ...(overlay ?? {}) };
  if (!overlay) return { ...base };
  return {
    ...base,
    ...overlay,
    toolsAllow: overlay.toolsAllow ?? base.toolsAllow,
  };
}

/** Deep-merge Luna config layers; later layers win for scalars. */
export function mergeLunaConfig(layers: LunaConfigDoc[]): LunaConfigDoc {
  let result: LunaConfigDoc = {};

  for (const layer of layers) {
    if (!layer) continue;

    result = {
      install: layer.install ? { ...result.install, ...layer.install } : result.install,
      mcpPort: layer.mcpPort !== undefined ? layer.mcpPort : result.mcpPort,
      // Per-key, so an overlay that adds one person keeps the rest. `mergeKeyedRecord` already
      // treats an explicit null as a delete, which is how `"users": { "bob": null }` in the local
      // layer removes an entry the default layer declared.
      users: mergeKeyedRecord<UserConfigDoc>(result.users, layer.users),
      owner: layer.owner !== undefined ? layer.owner : result.owner,
      mcpServers: mergeKeyedRecord<McpServerConfigDoc>(result.mcpServers, layer.mcpServers),
      providers: mergeProviders(result.providers, layer.providers),
      models: mergeModels(result.models, layer.models),
      // Flat and shallow, which is all it needs: three scalars and a socket path. Every layer that
      // sets one key keeps the others from below it.
      memory: layer.memory ? { ...result.memory, ...layer.memory } : result.memory,
      // Shallow like memory, and `languages` is meant to be replaced rather than concatenated:
      // an overlay saying which languages are spoken here is the whole list, not an addition to
      // whatever the defaults guessed.
      voice: layer.voice ? { ...result.voice, ...layer.voice } : result.voice,
      agent: mergeAgent(result.agent, layer.agent),
      apple: mergeApple(result.apple, layer.apple),
      email: mergeEmail(result.email, layer.email),
    };
  }

  return result;
}
