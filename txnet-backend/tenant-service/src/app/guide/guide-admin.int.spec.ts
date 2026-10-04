/**
 * Guide administration (F-414-c, ADR-0117), against a real Postgres built from
 * the committed migration history — RLS decides half of it: the platform's
 * owner writes `tenantId` NULL rows on the cross-tenant pool, a reseller its
 * own on the app pool, and neither reaches the other's.
 *
 * What a reader sees after each act is asked of the real `GuideReader`, so a
 * draft that leaked, an override that replaced too early or a hide that missed
 * fails here.
 *
 *   npm run test:int
 */
import { PrismaClient } from '@prisma/client';
import { TenantContext, objectKey, runWithTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import { GuideActor, GuideAdmin, GuideRefused } from './guide-admin';
import { GuideGenerations, GuideReader } from './guide-reader';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';

const admin = (tenantId: string): GuideActor => ({ userId: `${tenantId}-admin`, tenantId, permissions: ['guide.manage'] });
const PLATFORM_ADMIN = admin(PLATFORM);
const A_ADMIN = admin(RESELLER_A);
const B_ADMIN = admin(RESELLER_B);

const text = (t: string) => [{ type: 'text' as const, text: t }];
const ANDROID = { surface: 'any' as const, targetKind: 'os' as const, targetRef: 'android' };

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaClient;
let cross: PrismaClient;
let guides: GuideAdmin;
let reader: GuideReader;
const bumps: (string | null)[] = [];
/** Stored objects by key, as `ObjectStorage.stat` would find them. */
const files = new Map<string, { visibility: 'public' | 'private' }>();

/** What reseller `tenantId`'s users see on the Android slot, as `key:title`. */
async function seenBy(tenantId: string): Promise<string[]> {
  const { body } = await runWithTenant({ id: tenantId }, () =>
    reader.list(tenantId, { targetKind: 'os', targetRef: 'android', surface: 'panel' }, 'fa'),
  );
  return body.guides.map((g) => `${g.key}:${g.title}`);
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'accepted';
  } catch (e) {
    if (e instanceof GuideRefused) return e.reason;
    throw e;
  }
}

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  app = prismaAt(pg.appUrl);
  cross = prismaAt(pg.crossTenantUrl);
  for (const [id, type, slug] of [
    [PLATFORM, 'platform_owner', 'home'],
    [RESELLER_A, 'reseller', 'alpha'],
    [RESELLER_B, 'reseller', 'beta'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', '${type}', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind", "updatedAt")
    VALUES ('${PRODUCT}', NULL, 'vpn_basic', 'catalog.product.vpn_basic', 'network_access', now())
  `);
  // No Redis: generations fail, the reader serves uncached — every read is the database's.
  const noRedis = {
    get: async () => {
      throw new Error('no redis in this spec');
    },
  };
  const generations = { bump: async (t: string | null) => void bumps.push(t), of: async () => '' } as unknown as GuideGenerations;
  const storage = {
    stat: async (key: string) => (files.has(key) ? { key, private: files.get(key)?.visibility === 'private' } : null),
    put: async (_policy: unknown, path: string) => {
      const key = objectKey(TenantContext.current('fake put').id, path);
      files.set(key, { visibility: 'public' });
      return { key, sha256: 'x', size: 1 };
    },
  };
  const platformTenant = { id: async () => PLATFORM };
  guides = new GuideAdmin(app as never, cross as never, storage as never, platformTenant as never, generations);
  reader = new GuideReader(app as never, noRedis as never, new GuideGenerations(noRedis as never));
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), cross?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

describe("the platform's guides, edited as drafts (ADR-0117 point 1)", () => {
  let id: string;

  it('creates a draft no reseller sees, and publishes it to every reseller', async () => {
    const created = await guides.create(PLATFORM_ADMIN, {
      key: 'install_android',
      kind: 'os',
      texts: [{ lang: 'fa', title: 'نصب اندروید', blocks: text('یک') }],
      placements: [ANDROID],
    });
    id = created.id;
    expect([created.owner, created.state, created.readOnly]).toEqual(['platform', 'draft', false]);
    expect((await owner.guide.findUniqueOrThrow({ where: { id } })).tenantId).toBeNull();
    expect(await seenBy(RESELLER_A)).toEqual([]);

    const published = await guides.publish(PLATFORM_ADMIN, id);
    expect([published.state, published.draft, published.published.map((t) => t.title)]).toEqual(['published', [], ['نصب اندروید']]);
    expect(await seenBy(RESELLER_A)).toEqual(['install_android:نصب اندروید']);
    expect(await seenBy(RESELLER_B)).toEqual(['install_android:نصب اندروید']);
    expect(bumps).toContain(null);
  });

  it('keeps serving the published text while a new draft is edited; preview shows the draft', async () => {
    await guides.saveDraft(PLATFORM_ADMIN, id, [{ lang: 'fa', title: 'نسخه دو', blocks: text('دو') }]);
    expect(await seenBy(RESELLER_A)).toEqual(['install_android:نصب اندروید']);
    expect((await guides.preview(PLATFORM_ADMIN, id, 'fa')).title).toBe('نسخه دو');

    await guides.publish(PLATFORM_ADMIN, id);
    expect(await seenBy(RESELLER_A)).toEqual(['install_android:نسخه دو']);
    expect(await refusal(guides.publish(PLATFORM_ADMIN, id))).toBe('guide_no_draft');
  });

  it('discards a draft without touching the published text', async () => {
    await guides.saveDraft(PLATFORM_ADMIN, id, [{ lang: 'fa', title: 'دور ریخته', blocks: text('x') }]);
    await guides.discardDraft(PLATFORM_ADMIN, id);
    expect((await guides.get(PLATFORM_ADMIN, id)).draft).toEqual([]);
    expect(await seenBy(RESELLER_A)).toEqual(['install_android:نسخه دو']);
  });

  it('archives and restores', async () => {
    expect((await guides.archive(PLATFORM_ADMIN, id, true)).state).toBe('archived');
    expect(await seenBy(RESELLER_A)).toEqual([]);
    expect((await guides.archive(PLATFORM_ADMIN, id, false)).state).toBe('published');
    expect(await seenBy(RESELLER_A)).toEqual(['install_android:نسخه دو']);
  });

  it("a reseller reads the platform's guide but never changes it", async () => {
    const seen = await guides.get(A_ADMIN, id);
    expect([seen.owner, seen.readOnly, seen.draft]).toEqual(['platform', true, []]);
    for (const act of [
      () => guides.saveDraft(A_ADMIN, id, [{ lang: 'fa', title: 'x', blocks: text('x') }]),
      () => guides.publish(A_ADMIN, id),
      () => guides.archive(A_ADMIN, id, true),
      () => guides.setPlacements(A_ADMIN, id, []),
      () => guides.remove(A_ADMIN, id),
    ]) {
      expect(await refusal(act())).toBe('guide_unknown');
    }
  });
});

describe("a reseller's own copy and its hides (ADR-0115 point 2)", () => {
  let copy: string;

  it('lists the inherited guide, then overrides it as a draft the users do not see yet', async () => {
    const list = await guides.list(A_ADMIN, 'fa');
    expect(list.inherited.map((g) => [g.key, g.overriddenBy, g.hidden])).toEqual([['install_android', null, false]]);

    const own = await guides.override(A_ADMIN, 'install_android');
    copy = own.id;
    expect([own.owner, own.state, own.draft.map((t) => t.title), own.placements]).toEqual(['own', 'draft', ['نسخه دو'], [ANDROID]]);
    expect(await seenBy(RESELLER_A)).toEqual(['install_android:نسخه دو']);
    expect(await refusal(guides.override(A_ADMIN, 'install_android'))).toBe('guide_key_taken');
  });

  it("replaces the platform's for that reseller only, once published", async () => {
    await guides.saveDraft(A_ADMIN, copy, [{ lang: 'fa', title: 'روش ما', blocks: text('ما') }]);
    await guides.publish(A_ADMIN, copy);
    expect(await seenBy(RESELLER_A)).toEqual(['install_android:روش ما']);
    expect(await seenBy(RESELLER_B)).toEqual(['install_android:نسخه دو']);
    expect((await guides.list(A_ADMIN, 'fa')).inherited[0].overriddenBy).toBe(copy);
    expect(bumps).toContain(RESELLER_A);
  });

  it("another reseller never reaches the copy", async () => {
    expect(await refusal(guides.get(B_ADMIN, copy))).toBe('guide_unknown');
    expect(await refusal(guides.publish(B_ADMIN, copy))).toBe('guide_unknown');
  });

  it("hides the platform's guide for one reseller, and restores it", async () => {
    await guides.setHidden(B_ADMIN, 'install_android', true);
    expect(await seenBy(RESELLER_B)).toEqual([]);
    expect((await guides.list(B_ADMIN, 'fa')).inherited[0].hidden).toBe(true);
    await guides.setHidden(B_ADMIN, 'install_android', false);
    expect(await seenBy(RESELLER_B)).toEqual(['install_android:نسخه دو']);
  });

  it('refuses a hide or an override of what is not inherited, and either from the platform itself', async () => {
    expect(await refusal(guides.setHidden(B_ADMIN, 'no_such_guide', true))).toBe('guide_not_inherited');
    expect(await refusal(guides.override(B_ADMIN, 'no_such_guide'))).toBe('guide_not_inherited');
    expect(await refusal(guides.setHidden(PLATFORM_ADMIN, 'install_android', true))).toBe('guide_not_inherited');
  });

  it('deletes its own copy, and the platform guide shows again', async () => {
    await guides.remove(A_ADMIN, copy);
    expect(await seenBy(RESELLER_A)).toEqual(['install_android:نسخه دو']);
  });
});

describe('what a writer refuses', () => {
  it('a key taken by the same owner, or two texts in one language', async () => {
    const input = { key: 'dup', kind: 'section' as const, texts: [{ lang: 'fa' as const, title: 't', blocks: text('t') }] };
    await guides.create(B_ADMIN, input);
    expect(await refusal(guides.create(B_ADMIN, input))).toBe('guide_key_taken');
    expect(await refusal(guides.create(B_ADMIN, { ...input, key: 'dup2', texts: [...input.texts, ...input.texts] }))).toBe('guide_invalid');
  });

  it('a placement outside the registry, or a product nobody can see (invariant 5)', async () => {
    const { id } = await guides.create(B_ADMIN, { key: 'placed', kind: 'product', texts: [{ lang: 'fa', title: 't', blocks: text('t') }] });
    expect(await refusal(guides.setPlacements(B_ADMIN, id, [{ surface: 'bot', targetKind: 'route', targetRef: 'home' }]))).toBe('guide_slot');
    expect(await refusal(guides.setPlacements(B_ADMIN, id, [{ surface: 'any', targetKind: 'os', targetRef: 'beos' }]))).toBe('guide_slot');
    expect(
      await refusal(guides.setPlacements(B_ADMIN, id, [{ surface: 'any', targetKind: 'product', targetRef: '44444444-4444-4444-8444-444444444444' }])),
    ).toBe('guide_product_unknown');
    const placed = await guides.setPlacements(B_ADMIN, id, [{ surface: 'any', targetKind: 'product', targetRef: PRODUCT }]);
    expect(placed.placements).toEqual([{ surface: 'any', targetKind: 'product', targetRef: PRODUCT }]);
  });

  it("a file that is another reseller's, private, or missing; the platform's guides/ files are allowed (ADR-0117 point 2)", async () => {
    const { id } = await guides.create(B_ADMIN, { key: 'pictured', kind: 'os', texts: [{ lang: 'fa', title: 't', blocks: text('t') }] });
    const uploaded = await guides.upload(B_ADMIN, id, { buffer: Buffer.from('x'), mimetype: 'image/png' });
    expect(uploaded.key.startsWith(`tenants/${RESELLER_B}/guides/${id}/`)).toBe(true);
    const platformFile = objectKey(PLATFORM, 'guides/shared/android.png');
    const othersFile = objectKey(RESELLER_A, 'guides/x/a.png');
    const privateFile = objectKey(RESELLER_B, 'guides/x/secret.png');
    files.set(platformFile, { visibility: 'public' });
    files.set(othersFile, { visibility: 'public' });
    files.set(privateFile, { visibility: 'private' });
    const image = (file: string) => [{ lang: 'fa' as const, title: 't', blocks: [{ type: 'image' as const, file, alt: 'a' }] }];

    expect(await refusal(guides.saveDraft(B_ADMIN, id, image(uploaded.key)))).toBe('accepted');
    expect(await refusal(guides.saveDraft(B_ADMIN, id, image(platformFile)))).toBe('accepted');
    expect(await refusal(guides.saveDraft(B_ADMIN, id, image(othersFile)))).toBe('guide_file');
    expect(await refusal(guides.saveDraft(B_ADMIN, id, image(privateFile)))).toBe('guide_file');
    expect(await refusal(guides.saveDraft(B_ADMIN, id, image(objectKey(RESELLER_B, 'guides/x/missing.png'))))).toBe('guide_file');
  });
});
