/**
 * Reading guides (F-414-b, ADR-0115 point 3, ADR-0117 point 3): what one
 * tenant's users see for one placement — its own, else the platform's, a hide
 * dropping the platform's, in the asked language or the fallback order — and
 * the cache that answers a repeat with no query at all.
 *
 * The database half (RLS shows a tenant the platform's rows and its own) is
 * `guide-schema.int.spec.ts`'s; this is the resolver's.
 */
import { runWithTenant } from '@txnet-backend/shared-core';

import { GuideGenerations, GuideReader, GuideStoreRow } from './guide-reader';

const PLATFORM = null;
const A = '11111111-1111-4111-8111-111111111111';

const text = (t: string) => [{ type: 'text', text: t }];

function row(over: Partial<GuideStoreRow> & Pick<GuideStoreRow, 'key'>): GuideStoreRow {
  return {
    id: `${over.tenantId ?? 'p'}-${over.key}`,
    tenantId: PLATFORM,
    kind: 'os',
    sortOrder: 0,
    isActive: true,
    updatedAt: new Date('2026-10-04T00:00:00Z'),
    translations: [{ lang: 'fa', title: 'راهنما', blocks: text('fa') }],
    placements: [{ surface: 'any', targetKind: 'os', targetRef: 'android' }],
    ...over,
  };
}

/** A store the reader queries through `tenantTransaction`; counts every transaction. */
function fakeStore(rows: GuideStoreRow[], hidden: { tenantId: string; key: string }[] = []) {
  const visible = (tenantId: string) => rows.filter((r) => r.tenantId === null || r.tenantId === tenantId);
  const matches = (r: GuideStoreRow, where: Record<string, any>) => {
    if (where.tenantId !== undefined && r.tenantId !== where.tenantId) return false;
    if (where.key !== undefined && (typeof where.key === 'string' ? r.key !== where.key : !where.key.in.includes(r.key))) return false;
    if (where.isActive !== undefined && r.isActive !== where.isActive) return false;
    if (where.translations?.some && r.translations.length === 0) return false;
    const p = where.placements?.some;
    if (p && !r.placements.some((x) => x.targetKind === p.targetKind && x.targetRef === p.targetRef && p.surface.in.includes(x.surface))) return false;
    return true;
  };
  let tenant = '';
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, id: string) => {
      tenant = id;
    },
    guide: { findMany: async ({ where }: { where: Record<string, any> }) => visible(tenant).filter((r) => matches(r, where)) },
    guideHidden: { findMany: async () => hidden.filter((h) => h.tenantId === tenant) },
  };
  const store = { transactions: 0, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => (store.transactions++, fn(tx)) };
  return store;
}

function memoryRedis() {
  const data = new Map<string, string>();
  return {
    data,
    down: false,
    async get(k: string) {
      if (this.down) throw new Error('redis down');
      return data.get(k) ?? null;
    },
    async setIfAbsent(k: string, v: string) {
      if (this.down) throw new Error('redis down');
      if (!data.has(k)) data.set(k, v);
    },
    async set(k: string, v: string) {
      if (this.down) throw new Error('redis down');
      data.set(k, v);
    },
    async setWithTtl(k: string, v: string) {
      if (this.down) throw new Error('redis down');
      data.set(k, v);
    },
  };
}

function reader(rows: GuideStoreRow[], hidden: { tenantId: string; key: string }[] = []) {
  const store = fakeStore(rows, hidden);
  const redis = memoryRedis();
  const generations = new GuideGenerations(redis as never);
  return { store, redis, generations, reader: new GuideReader(store as never, redis as never, generations) };
}

const ANDROID = { targetKind: 'os', targetRef: 'android', surface: 'panel' } as const;
const asA = <T>(fn: () => Promise<T>) => runWithTenant({ id: A }, fn);

describe('GuideReader — which guide a tenant sees', () => {
  it('shows the platform guide placed there to a tenant with nothing of its own', async () => {
    const { reader: r } = reader([row({ key: 'install_android' })]);
    const { body } = await asA(() => r.list(A, ANDROID, 'fa'));
    expect(body.guides.map((g) => [g.key, g.owner])).toEqual([['install_android', 'platform']]);
  });

  it("replaces the platform's guide with the tenant's published one of the same key, wherever that one is placed", async () => {
    const { reader: r } = reader([
      row({ key: 'install_android' }),
      row({ key: 'install_android', tenantId: A, placements: [{ surface: 'any', targetKind: 'os', targetRef: 'ios' }] }),
    ]);
    const { body } = await asA(() => r.list(A, ANDROID, 'fa'));
    expect(body.guides).toEqual([]);
  });

  it('keeps the platform guide while the tenant only has a draft or an archived copy of it', async () => {
    const { reader: r } = reader([
      row({ key: 'install_android' }),
      row({ key: 'install_android', tenantId: A, translations: [] }),
      row({ key: 'install_ios', placements: [{ surface: 'any', targetKind: 'os', targetRef: 'android' }] }),
      row({ key: 'install_ios', tenantId: A, isActive: false }),
    ]);
    const { body } = await asA(() => r.list(A, ANDROID, 'fa'));
    expect(body.guides.map((g) => [g.key, g.owner])).toEqual([
      ['install_android', 'platform'],
      ['install_ios', 'platform'],
    ]);
  });

  it("drops a platform guide the tenant hid, and only for that tenant's key", async () => {
    const { reader: r } = reader([row({ key: 'install_android' }), row({ key: 'faq_android' })], [{ tenantId: A, key: 'install_android' }]);
    const { body } = await asA(() => r.list(A, ANDROID, 'fa'));
    expect(body.guides.map((g) => g.key)).toEqual(['faq_android']);
  });

  it('serves the asked language, else the fallback order, and says which it served', async () => {
    const { reader: r } = reader([
      row({ key: 'both', translations: [{ lang: 'fa', title: 'ف', blocks: text('fa') }, { lang: 'en', title: 'E', blocks: text('en') }] }),
      row({ key: 'fa_only' }),
    ]);
    const { body } = await asA(() => r.list(A, ANDROID, 'en'));
    expect(body.guides.map((g) => [g.key, g.lang, g.title])).toEqual([
      ['both', 'en', 'E'],
      ['fa_only', 'fa', 'راهنما'],
    ]);
  });

  it('answers one guide by key with the same rule', async () => {
    const { reader: r } = reader([row({ key: 'x' }), row({ key: 'x', tenantId: A, translations: [{ lang: 'fa', title: 'own', blocks: text('own') }] })]);
    const { body } = await asA(() => r.one(A, 'x', 'fa'));
    expect([body.guide?.owner, body.guide?.title]).toEqual(['own', 'own']);
  });
});

describe('GuideReader — cache and ETag', () => {
  it('answers a repeat from the cache with the same ETag and no transaction', async () => {
    const { reader: r, store } = reader([row({ key: 'install_android' })]);
    const first = await asA(() => r.list(A, ANDROID, 'fa'));
    const second = await asA(() => r.list(A, ANDROID, 'fa'));
    expect(second).toEqual(first);
    expect(store.transactions).toBe(1);
  });

  it('knows the ETag before reading anything, so a match is a 304 with no query', async () => {
    const { reader: r, store } = reader([row({ key: 'install_android' })]);
    const { etag } = await asA(() => r.list(A, ANDROID, 'fa'));
    expect(await asA(() => r.etag(A, ['list', 'os', 'android', 'panel', 'fa']))).toBe(etag);
    expect(store.transactions).toBe(1);
  });

  it('changes the ETag for every tenant on a platform write, and for one tenant on its own', async () => {
    const { reader: r, generations } = reader([row({ key: 'install_android' })]);
    const before = (await asA(() => r.list(A, ANDROID, 'fa'))).etag;
    await generations.bump(null);
    const afterPlatform = (await asA(() => r.list(A, ANDROID, 'fa'))).etag;
    await generations.bump(A);
    const afterOwn = (await asA(() => r.list(A, ANDROID, 'fa'))).etag;
    expect(new Set([before, afterPlatform, afterOwn]).size).toBe(3);
  });

  it('separates languages and placements in the ETag', async () => {
    const { reader: r } = reader([row({ key: 'install_android' })]);
    const fa = (await asA(() => r.list(A, ANDROID, 'fa'))).etag;
    const en = (await asA(() => r.list(A, ANDROID, 'en'))).etag;
    const ios = (await asA(() => r.list(A, { ...ANDROID, targetRef: 'ios' }, 'fa'))).etag;
    expect(new Set([fa, en, ios]).size).toBe(3);
  });

  it('still answers from the database, with no ETag, when Redis is down', async () => {
    const { reader: r, redis } = reader([row({ key: 'install_android' })]);
    redis.down = true;
    const { etag, body } = await asA(() => r.list(A, ANDROID, 'fa'));
    expect(etag).toBeNull();
    expect(body.guides).toHaveLength(1);
  });
});
