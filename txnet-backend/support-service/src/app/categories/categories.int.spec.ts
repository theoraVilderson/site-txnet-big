/**
 * A tenant's support categories (F-033-e, ADR-0112 point 6), against a real
 * Postgres built from the committed migration history.
 *
 * What would break silently, and only a database can show:
 *  - **the switch to the tenant's own set** — a tenant with any active
 *    category of its own sees only its own; with none (never made, or all
 *    retired) its users see the platform's defaults again. A wrong `where`
 *    shows both lists, or none, and reads like a configuration choice;
 *  - **one tenant's categories at another** (RLS, invariant 4) — read,
 *    edited or retired across the boundary;
 *  - **a category in use deleted** — a conversation's `categoryId` would point
 *    at nothing; one in use is retired, never deleted (ADR-0112 point 6);
 *  - **a retired category still accepted** on a new conversation.
 *
 *   npm run test:int
 */
import { PrismaClient } from '@prisma/client';
import { runWithTenant, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import { PresenceRedis, SupportAvailability } from '../availability/availability';
import { ConversationRefused, SupportCaller, SupportConversationService } from '../conversations/conversations.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SupportCategories } from './categories';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const RESELLER_A = '11111111-1111-4111-8111-1111111111c1';
const RESELLER_B = '22222222-2222-4222-8222-2222222222c2';
const ALICE: SupportCaller = { tenantId: RESELLER_A, userId: '33333333-3333-4333-8333-3333333333c1' };
const BEHNAZ: SupportCaller = { tenantId: RESELLER_B, userId: '33333333-3333-4333-8333-3333333333c2' };

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let users: SupportConversationService;
let categories: SupportCategories;

const as = <T>(caller: SupportCaller, work: () => Promise<T>) => runWithTenant({ id: caller.tenantId }, work);

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (e) {
    if (e instanceof ConversationRefused) return e.reason;
    throw e;
  }
  return 'accepted';
};

const noPresence: PresenceRedis = {
  zadd: async () => undefined,
  zrem: async () => undefined,
  zremrangebyscore: async () => undefined,
  zrangebyscore: async () => [],
  expire: async () => undefined,
};

/** What the caller's users are offered, as `key` in the caller's language order. */
const offered = async (caller: SupportCaller, lang = 'fa') => (await as(caller, () => users.categories(caller, lang))).map((c) => c.key);

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  for (const [id, slug] of [[RESELLER_A, 'alpha'], [RESELLER_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  const base = prismaAt(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  const limits: Record<string, number> = { SUPPORT_UNFINISHED_MAX: 50 };
  const config = { get: (key: string) => limits[key] ?? 'x'.repeat(32) } as never;
  const realtime = { message: async () => undefined, read: async () => undefined, typing: async () => undefined, status: async () => undefined, channelProof: async () => null } as never;
  const notifier = { tell: async () => false } as never;
  users = new SupportConversationService(app, config, realtime, new SupportAvailability(app, noPresence), notifier);
  categories = new SupportCategories(app);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

/** The platform's default keys, as the first test reads them. */
let platformKeys: string[];

describe("a tenant's own categories replace the platform's defaults (ADR-0112 point 6)", () => {
  it('offers the defaults while the tenant has none, and says so to its admin', async () => {
    platformKeys = await offered(ALICE);
    expect(platformKeys.length).toBeGreaterThan(0);
    const listed = await as(ALICE, () => categories.list(RESELLER_A, 'fa'));
    expect(listed.own).toEqual([]);
    expect(listed.usingPlatform).toBe(true);
    expect(listed.platform.map((c) => c.key)).toEqual(platformKeys);
  });

  it("offers only the tenant's own once it has one, by sortOrder, named in the reader's language", async () => {
    await as(ALICE, () => categories.create(RESELLER_A, { key: 'sales', sortOrder: 2, texts: [{ lang: 'fa', name: 'فروش' }, { lang: 'en', name: 'Sales' }] }));
    await as(ALICE, () => categories.create(RESELLER_A, { key: 'connection', sortOrder: 1, texts: [{ lang: 'fa', name: 'اتصال' }] }));

    expect(await offered(ALICE)).toEqual(['connection', 'sales']);
    const en = await as(ALICE, () => users.categories(ALICE, 'en'));
    expect(en.map((c) => c.name)).toEqual(['اتصال', 'Sales']);
    expect((await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).usingPlatform).toBe(false);
  });

  it("leaves another tenant on the defaults, and never shows or edits one tenant's category at another (invariant 4)", async () => {
    expect(await offered(BEHNAZ)).toEqual(platformKeys);
    expect((await as(BEHNAZ, () => categories.list(RESELLER_B, 'fa'))).own).toEqual([]);
    const theirs = (await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).own[0];
    expect(await refusal(as(BEHNAZ, () => categories.update(RESELLER_B, theirs.id, { isActive: false })))).toBe('category_unknown');
    expect(await refusal(as(BEHNAZ, () => categories.remove(RESELLER_B, theirs.id)))).toBe('category_unknown');
  });

  it('refuses a key taken, no name, a language twice, and a platform default as its own', async () => {
    expect(await refusal(as(ALICE, () => categories.create(RESELLER_A, { key: 'sales', texts: [{ lang: 'fa', name: 'x' }] })))).toBe('category_key_taken');
    expect(await refusal(as(ALICE, () => categories.create(RESELLER_A, { key: 'empty', texts: [] })))).toBe('category_invalid');
    expect(
      await refusal(as(ALICE, () => categories.create(RESELLER_A, { key: 'twice', texts: [{ lang: 'fa', name: 'a' }, { lang: 'fa', name: 'b' }] }))),
    ).toBe('category_invalid');
    const platformId = (await owner.supportCategory.findFirstOrThrow({ where: { tenantId: null } })).id;
    expect(await refusal(as(ALICE, () => categories.update(RESELLER_A, platformId, { isActive: false })))).toBe('category_unknown');
  });

  it('replaces every name at once on an edit', async () => {
    const sales = (await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).own.find((c) => c.key === 'sales')!;
    const edited = await as(ALICE, () => categories.update(RESELLER_A, sales.id, { texts: [{ lang: 'en', name: 'Buying' }] }));
    expect(edited.texts).toEqual([{ lang: 'en', name: 'Buying' }]);
  });
});

describe('a category in use is retired, never deleted', () => {
  it('deletes one nobody used, and refuses one a conversation names', async () => {
    const spare = await as(ALICE, () => categories.create(RESELLER_A, { key: 'spare', texts: [{ lang: 'fa', name: 'یدک' }] }));
    await as(ALICE, () => categories.remove(RESELLER_A, spare.id));
    expect((await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).own.map((c) => c.key)).not.toContain('spare');

    const used = (await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).own.find((c) => c.key === 'connection')!;
    await as(ALICE, () => users.open(ALICE, { body: 'no connection', categoryId: used.id }));
    expect(await refusal(as(ALICE, () => categories.remove(RESELLER_A, used.id)))).toBe('category_in_use');
    expect((await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).own.find((c) => c.id === used.id)?.inUse).toBe(true);
  });

  it('hides a retired one from users and refuses it on a new conversation', async () => {
    const used = (await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).own.find((c) => c.key === 'connection')!;
    await as(ALICE, () => categories.update(RESELLER_A, used.id, { isActive: false }));
    expect(await offered(ALICE)).toEqual(['sales']);
    expect(await refusal(as(ALICE, () => users.open(ALICE, { body: 'again', categoryId: used.id })))).toBe('category_unknown');
  });

  it('brings the defaults back once every own category is retired', async () => {
    const sales = (await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).own.find((c) => c.key === 'sales')!;
    await as(ALICE, () => categories.update(RESELLER_A, sales.id, { isActive: false }));
    expect(await offered(ALICE)).toEqual(platformKeys);
    expect((await as(ALICE, () => categories.list(RESELLER_A, 'fa'))).usingPlatform).toBe(true);
  });
});
