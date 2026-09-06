// @vitest-environment node
//
// `locale-store` is `import "server-only"` — it holds the process-wide gRPC
// client, so its spec runs in node and stubs the client rather than the wire.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const createLocaleClient = vi.fn();
vi.mock('@txnet/locale-client', () => ({ createLocaleClient }));

type Meta = {
  code: string;
  name: string;
  short_name: string;
  native_name: string;
  dir: string;
  locale: string;
};

const FA: Meta = {
  code: 'fa',
  name: 'Persian',
  short_name: 'FA',
  native_name: 'فارسی',
  dir: 'rtl',
  locale: 'fa-IR',
};
const EN: Meta = {
  code: 'en',
  name: 'English',
  short_name: 'EN',
  native_name: 'English',
  dir: 'ltr',
  locale: 'en-US',
};

/** A stand-in for the gRPC client's in-process cache. */
function fakeClient(options: {
  locales?: Meta[];
  namespaces?: Record<string, Record<string, Record<string, string>>>;
  versions?: Record<string, string>;
  ready?: () => Promise<void>;
  availableLocales?: () => Promise<Meta[]>;
}) {
  const namespaces = options.namespaces ?? {};
  const versions = options.versions ?? {};
  return {
    ready: options.ready ?? (() => Promise.resolve()),
    resync: vi.fn(async () => undefined),
    availableLocales:
      options.availableLocales ?? (async () => options.locales ?? [FA, EN]),
    languages: () => Object.keys(namespaces),
    namespace: vi.fn((lang: string, ns: string) => namespaces[lang]?.[ns]),
    cached: (lang: string) =>
      namespaces[lang]
        ? {
            version: versions[lang] ?? 'v1',
            namespaces: Object.fromEntries(
              Object.entries(namespaces[lang]).map(([ns, entries]) => [
                ns,
                { entries },
              ]),
            ),
          }
        : undefined,
  };
}

type Store = typeof import('./locale-store');

/** Fresh module + fresh process globals for every test. */
async function load(client: ReturnType<typeof fakeClient>): Promise<Store> {
  createLocaleClient.mockReturnValue(client);
  vi.resetModules();
  return import('./locale-store');
}

beforeEach(() => {
  for (const key of [
    'localeClient',
    'localeBoot',
    'localeMetaMap',
    'availableLocales',
    'compiledCache',
    'nsCache',
  ]) {
    delete (global as Record<string, unknown>)[key];
  }
  createLocaleClient.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getDir', () => {
  it('reads the direction locale-service advertises', async () => {
    const store = await load(fakeClient({}));
    await store.initStore();

    expect(store.getDir('fa')).toBe('rtl');
    expect(store.getDir('en')).toBe('ltr');
  });

  it('falls back to ltr for a language nobody advertises', async () => {
    const store = await load(fakeClient({}));
    await store.initStore();

    expect(store.getDir('kl')).toBe('ltr');
  });

  it('falls back to ltr before the store has booted at all', async () => {
    const store = await load(fakeClient({}));

    // no initStore(): the request path must still render
    expect(store.getDir('fa')).toBe('ltr');
    expect(store.isInitialized()).toBe(false);
  });

  it('treats any direction that is not exactly "rtl" as ltr', async () => {
    const store = await load(
      fakeClient({ locales: [{ ...FA, dir: 'RTL' }, EN] }),
    );
    await store.initStore();

    expect(store.getDir('fa')).toBe('ltr');
  });
});

describe('the metadata map', () => {
  it('exposes every advertised locale after boot', async () => {
    const store = await load(fakeClient({}));
    await store.initStore();

    expect(store.getAvailableLocales()).toEqual(['fa', 'en']);
    expect(store.getLocaleMeta('fa')).toEqual({
      code: 'fa',
      name: 'Persian',
      shortName: 'FA',
      englishName: 'Persian',
      nativeName: 'فارسی',
      dir: 'rtl',
      locale: 'fa-IR',
    });
    expect(store.isInitialized()).toBe(true);
  });

  it('is empty, not undefined, before boot', async () => {
    const store = await load(fakeClient({}));

    expect(store.getAvailableLocales()).toEqual([]);
    expect(store.getLocaleMeta('fa')).toBeUndefined();
  });
});

describe('initStore', () => {
  it('is single-flight: concurrent callers share one boot', async () => {
    const ready = vi.fn(async () => undefined);
    const store = await load(fakeClient({ ready }));

    await Promise.all([store.initStore(), store.initStore(), store.initStore()]);

    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('rejects when metadata came back empty, and lets the next call retry', async () => {
    const availableLocales = vi
      .fn<() => Promise<Meta[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([FA, EN]);
    const store = await load(fakeClient({ availableLocales }));

    await expect(store.initStore()).rejects.toThrow('locale metadata empty');
    // The empty map is still assigned before the throw, so `isInitialized()`
    // says true — what a caller can actually observe is that there are no
    // locales, which is what `ensureReady` retries against.
    expect(store.getAvailableLocales()).toEqual([]);

    await store.initStore();
    expect(store.getAvailableLocales()).toEqual(['fa', 'en']);
  });

  it('survives a metadata fetch that throws — the boot fails, it does not crash the render', async () => {
    const store = await load(
      fakeClient({
        availableLocales: async () => {
          throw new Error('locale-service unreachable');
        },
      }),
    );

    await expect(store.initStore()).rejects.toThrow('locale metadata empty');
  });
});

describe('ensureReady', () => {
  it('returns immediately once the store is warm, without re-booting', async () => {
    const startWatching = vi.fn(async () => undefined);
    const store = await load(fakeClient({}));
    await store.initStore();

    await store.ensureReady(startWatching);

    expect(startWatching).not.toHaveBeenCalled();
  });

  it('boots and starts the watch on a cold request path', async () => {
    const startWatching = vi.fn(async () => undefined);
    const store = await load(fakeClient({}));

    await store.ensureReady(startWatching);

    expect(startWatching).toHaveBeenCalledOnce();
    expect(store.isInitialized()).toBe(true);
  });

  it('swallows a failed boot so the page renders with fallback strings', async () => {
    const store = await load(
      fakeClient({
        ready: async () => {
          throw new Error('no connection');
        },
      }),
    );

    await expect(
      store.ensureReady(async () => undefined),
    ).resolves.toBeUndefined();
    expect(store.isInitialized()).toBe(false);
  });

  it('gives up after the boot deadline instead of holding the request', async () => {
    vi.useFakeTimers();
    const store = await load(
      fakeClient({ ready: () => new Promise<void>(() => {}) }),
    );

    const pending = store.ensureReady(async () => undefined);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toBeUndefined();
    expect(store.isInitialized()).toBe(false);
    vi.useRealTimers();
  });
});

describe('namespaces', () => {
  const namespaces = {
    fa: { auth: { 'login.title': 'ورود', greeting: 'سلام {{name}}' } },
  };

  it('unflattens dotted keys into a tree', async () => {
    const store = await load(fakeClient({ namespaces }));
    await store.initStore();

    expect(store.getNamespace('fa', 'auth')).toEqual({
      login: { title: 'ورود' },
      greeting: 'سلام {{name}}',
    });
  });

  it('returns undefined for a namespace the language does not have', async () => {
    const store = await load(fakeClient({ namespaces }));
    await store.initStore();

    expect(store.getNamespace('fa', 'billing')).toBeUndefined();
    expect(store.getNamespace('en', 'auth')).toBeUndefined();
  });

  it('compiles {{var}} texts to token arrays and leaves plain ones alone', async () => {
    const store = await load(fakeClient({ namespaces }));
    await store.initStore();

    expect(store.getCompiledNamespace('fa', 'auth')).toEqual({
      'login.title': 'ورود',
      greeting: ['سلام ', 'name', ''],
    });
  });

  it('is empty, not a crash, for a namespace that is not there', async () => {
    const store = await load(fakeClient({ namespaces }));
    await store.initStore();

    expect(store.getCompiledNamespace('fa', 'billing')).toEqual({});
  });

  it('reads nothing at all before the client exists, rather than throwing', async () => {
    const store = await load(fakeClient({ namespaces }));

    expect(store.getNamespace('fa', 'auth')).toBeUndefined();
    expect(store.getCompiledNamespace('fa', 'auth')).toEqual({});
    expect(store.getStore()).toEqual({});
  });

  it('snapshots every language once loaded', async () => {
    const store = await load(fakeClient({ namespaces }));
    await store.initStore();

    expect(store.getStore()).toEqual({
      fa: { auth: { login: { title: 'ورود' }, greeting: 'سلام {{name}}' } },
    });
  });
});

describe('the version-keyed caches', () => {
  it('compiles once while the version holds', async () => {
    const client = fakeClient({
      namespaces: { fa: { auth: { a: 'x' } } },
      versions: { fa: 'v1' },
    });
    const store = await load(client);
    await store.initStore();

    const first = store.getCompiledNamespace('fa', 'auth');
    const second = store.getCompiledNamespace('fa', 'auth');

    expect(second).toBe(first);
    expect(client.namespace).toHaveBeenCalledTimes(1);
  });

  it('recompiles when the watch stream moves the version on', async () => {
    const versions = { fa: 'v1' };
    const client = fakeClient({
      namespaces: { fa: { auth: { a: 'x' } } },
      versions,
    });
    const store = await load(client);
    await store.initStore();
    const first = store.getCompiledNamespace('fa', 'auth');

    versions.fa = 'v2';
    const second = store.getCompiledNamespace('fa', 'auth');

    expect(second).not.toBe(first);
    expect(client.namespace).toHaveBeenCalledTimes(2);
  });

  it('caches the unflattened tree the same way', async () => {
    const client = fakeClient({ namespaces: { fa: { auth: { 'a.b': 'x' } } } });
    const store = await load(client);
    await store.initStore();

    expect(store.getNamespace('fa', 'auth')).toBe(
      store.getNamespace('fa', 'auth'),
    );
    expect(client.namespace).toHaveBeenCalledTimes(1);
  });

  it('reports the version of every loaded language', async () => {
    const store = await load(
      fakeClient({
        namespaces: { fa: { auth: {} }, en: { auth: {} } },
        versions: { fa: 'v3', en: 'v7' },
      }),
    );
    await store.initStore();

    expect(store.getVersion()).toBe('fa:v3|en:v7');
  });

  it('reports "unknown" before there is a client at all', async () => {
    const store = await load(fakeClient({}));

    expect(store.getVersion()).toBe('unknown');
  });
});

describe('reloadStore', () => {
  it('re-syncs, refreshes the metadata and drops the derived caches', async () => {
    const client = fakeClient({ namespaces: { fa: { auth: { a: 'x' } } } });
    const store = await load(client);
    await store.initStore();
    const before = store.getCompiledNamespace('fa', 'auth');

    await store.reloadStore();
    const after = store.getCompiledNamespace('fa', 'auth');

    expect(client.resync).toHaveBeenCalledOnce();
    expect(store.getAvailableLocales()).toEqual(['fa', 'en']);
    expect(after).not.toBe(before);
  });

  it('keeps the cached data when the re-sync fails', async () => {
    const client = fakeClient({ namespaces: { fa: { auth: { a: 'x' } } } });
    const store = await load(client);
    await store.initStore();
    client.resync.mockRejectedValueOnce(new Error('stream dropped'));

    await expect(store.reloadStore()).resolves.toBeUndefined();

    expect(store.getAvailableLocales()).toEqual(['fa', 'en']);
    expect(store.getCompiledNamespace('fa', 'auth')).toEqual({ a: 'x' });
  });
});
