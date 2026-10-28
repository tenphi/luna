import { describe, expect, it } from 'vitest';

import { mergeLunaConfig } from './merge.js';
import type { LunaConfigDoc } from './schema.js';

/** default.jsonc → local.jsonc, the only two layers that exist at runtime. */
function merge(base: LunaConfigDoc, overlay: LunaConfigDoc): LunaConfigDoc {
  return mergeLunaConfig([base, overlay]);
}

describe('mergeLunaConfig models', () => {
  it('lets the overlay override one field without dropping the rest', () => {
    // The property that matters: `luna config models set --id x` writes only the id, and the
    // provider chosen at setup has to survive it.
    const merged = merge(
      { models: { main: { provider: 'openai', id: 'gpt-4o' } } },
      { models: { main: { id: 'gpt-5.6-luna' } } },
    );
    expect(merged.models?.main).toEqual({ provider: 'openai', id: 'gpt-5.6-luna' });
  });

  it('carries the role through when only one layer mentions models', () => {
    const models = { main: { id: 'a', provider: 'openai' } };
    expect(merge({ models }, {}).models).toEqual(models);
    expect(merge({}, { models }).models).toEqual(models);
  });

  it('leaves models absent when neither layer has any', () => {
    expect(merge({}, {}).models).toBeUndefined();
  });
});

describe('mergeLunaConfig users + owner', () => {
  it('carries the roster through from the local layer', () => {
    // The failure this guards: a new top-level section that isn't added to mergeLunaConfig parses
    // fine, type-checks fine, and silently vanishes — leaving an install with no users at all.
    const merged = merge(
      { users: {}, owner: null },
      { users: { ada: { telegramHandle: 'ada_marlow' } }, owner: 'ada' },
    );
    expect(merged.users?.ada?.telegramHandle).toBe('ada_marlow');
    expect(merged.owner).toBe('ada');
  });

  it('merges per key, so adding one person keeps the others', () => {
    const merged = merge(
      { users: { ada: { name: 'Ada', telegramHandle: 'ada_marlow' } } },
      { users: { bo: { telegramHandle: 'bo_luna' } } },
    );
    expect(Object.keys(merged.users ?? {}).sort()).toEqual(['ada', 'bo']);
    expect(merged.users?.ada?.name).toBe('Ada');
  });

  it('merges fields within one person rather than replacing the entry', () => {
    const merged = merge(
      { users: { ada: { name: 'Ada', telegramHandle: 'ada_marlow' } } },
      { users: { ada: { memoryPage: 'people/ada-marlow' } } },
    );
    expect(merged.users?.ada).toEqual({
      name: 'Ada',
      telegramHandle: 'ada_marlow',
      memoryPage: 'people/ada-marlow',
    });
  });

  it('lets an explicit null in the overlay delete a person', () => {
    const merged = merge({ users: { ada: {}, bob: {} } }, {
      users: { bob: null },
    } as unknown as LunaConfigDoc);
    expect(Object.keys(merged.users ?? {})).toEqual(['ada']);
  });

  it('keeps the base owner when the overlay does not mention one', () => {
    expect(merge({ owner: 'ada' }, {}).owner).toBe('ada');
  });

  it('lets the overlay clear the owner explicitly', () => {
    expect(merge({ owner: 'ada' }, { owner: null }).owner).toBeNull();
  });

  it('leaves both absent when neither layer has any', () => {
    expect(merge({}, {}).owner).toBeUndefined();
    expect(merge({}, {}).users).toEqual({});
  });
});

describe('carrying every declared section through the merge', () => {
  // This merge rebuilds the document from an explicit list of keys, so a section it has never
  // heard of is not partially merged — it is *dropped*, in both layers at once. `voice` shipped
  // that way: committed defaults and the local overlay both declared it, `loadLunaConfig()`
  // returned undefined, and the feature ran on its hardcoded fallbacks with no error anywhere.
  // Adding a section to the schema means adding it here, and this is what says so.
  it('keeps a section that only the defaults declare', () => {
    expect(merge({ voice: { enabled: true, backend: 'auto' } }, {}).voice).toEqual({
      enabled: true,
      backend: 'auto',
    });
  });

  it('lets an overlay change one key of a section without dropping the rest', () => {
    const merged = merge(
      { voice: { enabled: true, backend: 'auto', maxDurationSec: 600 } },
      {
        voice: { backend: 'model' },
      },
    );

    expect(merged.voice).toEqual({ enabled: true, backend: 'model', maxDurationSec: 600 });
  });

  it('replaces the spoken languages wholesale rather than concatenating them', () => {
    // "Which languages are spoken here" is a complete answer, not an addition to whatever the
    // defaults guessed — an overlay naming ru-RU must not leave en-US in the list behind it.
    const merged = merge({ voice: { languages: ['en-US'] } }, { voice: { languages: ['ru-RU'] } });

    expect(merged.voice?.languages).toEqual(['ru-RU']);
  });
});
