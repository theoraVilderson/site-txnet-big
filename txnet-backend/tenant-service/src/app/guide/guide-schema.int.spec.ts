/**
 * Guide storage (F-414-a, ADR-0115), against a real Postgres built from the
 * committed migration history.
 *
 * Only a database can say any of it: every tenant reads the platform's guides
 * (`tenantId` NULL) and its own, never another reseller's, and never writes a
 * platform row; a key is one guide per owner, so a reseller may hold its own
 * copy under the platform's key (that is how it replaces one); a hide is a
 * tenant's own row; texts, placements and hides are policied on their own.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const PLATFORM_GUIDE = '88888888-8888-4888-8888-888888888801';
const A_GUIDE = '88888888-8888-4888-8888-8888888888a1';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaClient;

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

/** The Postgres error a statement raised, or `accepted`. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'accepted';
  } catch (e) {
    const message = (e as Error).message;
    if (/row-level security/i.test(message)) return 'rls';
    if (/unique constraint|duplicate key|P2002/i.test(message)) return 'unique';
    if (/check constraint|violates check/i.test(message)) return 'check';
    if (/invalid input value for enum/i.test(message)) return 'enum';
    return message;
  }
}

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  app = prismaAt(pg.appUrl);
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
    INSERT INTO guide.guide (id, "tenantId", key, kind, "updatedAt") VALUES ('${PLATFORM_GUIDE}', NULL, 'install_android_v2rayng', 'app', now())
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO guide.guide_translation ("guideId", "tenantId", lang, title, body) VALUES ('${PLATFORM_GUIDE}', NULL, 'fa', 'نصب روی اندروید', '۱. اپ را نصب کنید.')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO guide.guide_placement (id, "guideId", "tenantId", surface, "targetKind", "targetRef") VALUES (gen_random_uuid(), '${PLATFORM_GUIDE}', NULL, 'any', 'os', 'android')
  `);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

describe('who reads and writes a guide (invariant 1)', () => {
  it("every reseller reads the platform's guide, its text and its placement", async () => {
    for (const t of [RESELLER_A, RESELLER_B]) {
      const seen = await asTenant(t, (tx) =>
        tx.guide.findMany({ where: { key: 'install_android_v2rayng' }, include: { translations: true, placements: true } }),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0].translations.map((x) => x.lang)).toEqual(['fa']);
      expect(seen[0].placements.map((p) => p.targetRef)).toEqual(['android']);
    }
  });

  it("a reseller writes its own guide, and another reseller never sees it", async () => {
    await asTenant(RESELLER_A, (tx) =>
      tx.guide.create({
        data: {
          id: A_GUIDE,
          tenantId: RESELLER_A,
          // The platform's key: this is how a reseller replaces one (ADR-0115 point 2).
          key: 'install_android_v2rayng',
          kind: 'app',
          translations: { create: { tenantId: RESELLER_A, lang: 'fa', title: 'نصب اختصاصی', body: 'به روش ما.' } },
          placements: { create: { tenantId: RESELLER_A, surface: 'panel', targetKind: 'os', targetRef: 'android' } },
        },
      }),
    );
    expect(await asTenant(RESELLER_A, (tx) => tx.guide.count({ where: { key: 'install_android_v2rayng' } }))).toBe(2);
    expect(await asTenant(RESELLER_B, (tx) => tx.guide.findMany({ where: { id: A_GUIDE } }))).toEqual([]);
    expect(await asTenant(RESELLER_B, (tx) => tx.guideTranslation.findMany({ where: { guideId: A_GUIDE } }))).toEqual([]);
    expect(await asTenant(RESELLER_B, (tx) => tx.guidePlacement.findMany({ where: { guideId: A_GUIDE } }))).toEqual([]);
  });

  it("a reseller never writes the platform's guide, its text or its placement", async () => {
    expect(await refusal(asTenant(RESELLER_A, (tx) => tx.guide.create({ data: { tenantId: null, key: 'sneaky', kind: 'section' } })))).toBe('rls');
    expect(
      await refusal(asTenant(RESELLER_A, (tx) => tx.guideTranslation.create({ data: { guideId: PLATFORM_GUIDE, tenantId: null, lang: 'en', title: 'x', body: 'x' } }))),
    ).toBe('rls');
    // A row it reads but does not own: the update is refused, never applied.
    expect(await refusal(asTenant(RESELLER_A, (tx) => tx.guide.updateMany({ where: { id: PLATFORM_GUIDE }, data: { isActive: false } })))).toBe('rls');
    expect((await owner.guide.findUniqueOrThrow({ where: { id: PLATFORM_GUIDE } })).isActive).toBe(true);
  });
});

describe('keys (invariant 2)', () => {
  it('is one guide per key per owner — the platform counted as one owner', async () => {
    expect(await refusal(owner.guide.create({ data: { tenantId: null, key: 'install_android_v2rayng', kind: 'app' } }))).toBe('unique');
    expect(await refusal(asTenant(RESELLER_A, (tx) => tx.guide.create({ data: { tenantId: RESELLER_A, key: 'install_android_v2rayng', kind: 'app' } })))).toBe(
      'unique',
    );
    // Another reseller's copy under the same key is its own.
    expect(await refusal(asTenant(RESELLER_B, (tx) => tx.guide.create({ data: { tenantId: RESELLER_B, key: 'install_android_v2rayng', kind: 'app' } })))).toBe(
      'accepted',
    );
  });

  it('holds the key to a slug, a text to one per language and a title and body to their lengths', async () => {
    expect(await refusal(owner.guide.create({ data: { tenantId: null, key: 'Has Spaces', kind: 'app' } }))).toBe('check');
    expect(
      await refusal(owner.guideTranslation.create({ data: { guideId: PLATFORM_GUIDE, tenantId: null, lang: 'fa', title: 'again', body: 'x' } })),
    ).toBe('unique');
    expect(await refusal(owner.guideTranslation.create({ data: { guideId: PLATFORM_GUIDE, tenantId: null, lang: 'en', title: '', body: 'x' } }))).toBe(
      'check',
    );
  });

  it('places a guide once per surface and target', async () => {
    expect(
      await refusal(owner.guidePlacement.create({ data: { guideId: PLATFORM_GUIDE, tenantId: null, surface: 'any', targetKind: 'os', targetRef: 'android' } })),
    ).toBe('unique');
  });
});

describe('a hide (ADR-0115 point 2)', () => {
  it("is a tenant's own row, once per key, and another reseller never sees it", async () => {
    await asTenant(RESELLER_A, (tx) => tx.guideHidden.create({ data: { tenantId: RESELLER_A, key: 'install_android_v2rayng' } }));
    expect(await refusal(asTenant(RESELLER_A, (tx) => tx.guideHidden.create({ data: { tenantId: RESELLER_A, key: 'install_android_v2rayng' } })))).toBe(
      'unique',
    );
    expect(await asTenant(RESELLER_B, (tx) => tx.guideHidden.count())).toBe(0);
    expect(await refusal(asTenant(RESELLER_A, (tx) => tx.guideHidden.create({ data: { tenantId: RESELLER_B, key: 'x' } })))).toBe('rls');
  });
});
