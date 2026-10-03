/**
 * The wheel's and the lottery's storage (F-707-a, ADR-0111 points 1, 2, 4, 5),
 * against a real Postgres built from the committed migration history.
 *
 * Every rule here is one a spin or a draw racing another, or an admin editing
 * a row by hand, would otherwise break with no error: a tenant reads only its
 * own; a wheel version and its prizes are fixed once written; the day's cost
 * never passes the cap and a prize never passes its stock; an awarded spin's
 * place in the day is a database unique; no row pays cash; a lottery is frozen
 * once published; a draw happens once and its seed is never rewritten.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import { PrismaService } from '../prisma/prisma.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ROLE = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const USER_A = '55555555-5555-4555-8555-5555555555a1';
const USER_A2 = '55555555-5555-4555-8555-5555555555a2';
const USER_A3 = '55555555-5555-4555-8555-5555555555a3';
const USER_B = '55555555-5555-4555-8555-5555555555b1';
const FP_A = '66666666-6666-4666-8666-6666666666a1';
const FP_B = '66666666-6666-4666-8666-6666666666b1';
const GROUP_A = '77777777-7777-4777-8777-7777777777a1';
const GROUP_B = '77777777-7777-4777-8777-7777777777b1';

const WHEEL_A = '88888888-8888-4888-8888-8888888888a1';
const WHEEL_A2 = '88888888-8888-4888-8888-8888888888a2';
const WHEEL_B = '88888888-8888-4888-8888-8888888888b1';
const GB_PRIZE = '99999999-9999-4999-8999-9999999999a1';
const EMPTY_PRIZE = '99999999-9999-4999-8999-9999999999a2';
const V2_PRIZE = '99999999-9999-4999-8999-9999999999a3';

const DAY = '2026-10-03';

let pg: PostgresFixture;
let owner: PrismaClient;
let cross: PrismaClient;
let app: PrismaService;

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

const version = (id: string, tenantId: string, n: number, over = '') => `
  INSERT INTO engagement.spin_wheel_config (id, "tenantId", version, "effectiveFromDay", "dailyBudgetCapAmount", "currencyCode", "maxSpinsPerAccountPerDay", "createdByAdminId"${over ? ', "userGroupId"' : ''})
  VALUES ('${id}', '${tenantId}', ${n}, '${DAY}', 100, 'IRT', 2, '${ADMIN}'${over ? `, '${over}'` : ''})`;

const prize = (id: string, wheel: string, position: number, shape: string, tenantId = TENANT_A) => `
  INSERT INTO engagement.spin_wheel_prize (id, "tenantId", "wheelConfigId", position, label, "probabilityWeight", "prizeType", "prizeValue", "costAmount", "couponTemplateId", "couponValidDays", "variantId", "dailyStockLimit")
  VALUES ('${id}', '${tenantId}', '${wheel}', ${position}, 'slot', 10, ${shape})`;

/** prizeType, prizeValue, costAmount, couponTemplateId, couponValidDays, variantId, dailyStockLimit */
const GB = `'bonus_traffic_gb', 2, 30, NULL, NULL, NULL, 3`;
const EMPTY = `'empty', 0, 0, NULL, NULL, NULL, NULL`;

let attempts = 0;
const attempt = (o: { status?: string; seq?: number | null; key?: string; user?: string; tenant?: string; fp?: string; awarded?: string | null; reason?: string | null }) => {
  attempts += 1;
  const status = o.status ?? 'awarded';
  const seq = o.seq === undefined ? 1 : o.seq;
  const reason = o.reason === undefined ? (status === 'awarded' ? null : 'cooldown') : o.reason;
  const awarded = o.awarded === undefined ? (status === 'awarded' ? GB_PRIZE : null) : o.awarded;
  return owner.$executeRawUnsafe(`
    INSERT INTO engagement.spin_wheel_attempt (id, "tenantId", "wheelConfigId", "userId", "deviceFingerprintId", "tenantDay", seq, "idempotencyKey",
      "eligibilityCheckSnapshotJson", "pickedPrizeId", "prizeAwardedId", "currencyCode", status, "refusalReason")
    VALUES (gen_random_uuid(), '${o.tenant ?? TENANT_A}', '${WHEEL_A}', '${o.user ?? USER_A}', '${o.fp ?? FP_A}', '${DAY}', ${seq ?? 'NULL'},
      '${o.key ?? `k-${attempts}`}', '{}', ${awarded ? `'${awarded}'` : 'NULL'}, ${awarded ? `'${awarded}'` : 'NULL'}, 'IRT', '${status}',
      ${reason ? `'${reason}'` : 'NULL'})`);
};

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  cross = prismaAt(pg.crossTenantUrl);

  await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'User', true)`);
  for (const [id, slug] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())`);
  }
  for (const [id, tenantId] of [[USER_A, TENANT_A], [USER_A2, TENANT_A], [USER_A3, TENANT_A], [USER_B, TENANT_B]]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES ('${id}', '${tenantId}', 'Someone', 'x', '${ROLE}', now())`);
  }
  for (const [id, tenantId, userId] of [[FP_A, TENANT_A, USER_A], [FP_B, TENANT_B, USER_B]]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO fraud.device_fingerprint (id, "tenantId", "userId", channel, "fingerprintHash") VALUES ('${id}', '${tenantId}', '${userId}', 'web', 'h-${id}')`);
  }
  for (const [id, tenantId] of [[GROUP_A, TENANT_A], [GROUP_B, TENANT_B]]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO governance.user_group (id, "tenantId", name, "createdByAdminId") VALUES ('${id}', '${tenantId}', 'vip', '${ADMIN}')`);
  }
  // A version and its prizes, written in one transaction as F-707-c will.
  await owner.$transaction([
    owner.$executeRawUnsafe(version(WHEEL_A, TENANT_A, 1, GROUP_A)),
    owner.$executeRawUnsafe(prize(GB_PRIZE, WHEEL_A, 1, GB)),
    owner.$executeRawUnsafe(prize(EMPTY_PRIZE, WHEEL_A, 2, EMPTY)),
  ]);
  await owner.$transaction([
    owner.$executeRawUnsafe(version(WHEEL_A2, TENANT_A, 2)),
    owner.$executeRawUnsafe(prize(V2_PRIZE, WHEEL_A2, 1, GB)),
  ]);
  await owner.$executeRawUnsafe(version(WHEEL_B, TENANT_B, 1));

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect(), cross?.$disconnect()]);
  await pg?.stop();
});

describe('a tenant reads only its own', () => {
  it('wheel versions, prizes and lotteries', async () => {
    await owner.$executeRawUnsafe(`
      INSERT INTO engagement.lottery (id, "tenantId", "userGroupId", title, "entryMode", "closesAt", "createdByAdminId")
      VALUES ('aaaaaaaa-0000-4000-8000-0000000000b1', '${TENANT_B}', '${GROUP_B}', 'B draw', 'automatic', now() + interval '1 day', '${ADMIN}')`);
    const seen = await asTenant(TENANT_B, async (tx) => ({
      versions: (await tx.spinWheelConfig.findMany({ select: { id: true } })).map((v) => v.id),
      prizes: await tx.spinWheelPrize.count(),
      lotteries: await tx.lottery.count(),
    }));
    expect(seen).toEqual({ versions: [WHEEL_B], prizes: 0, lotteries: 1 });
    await expect(asTenant(TENANT_A, (tx) => tx.lottery.count())).resolves.toBe(0);
  });
});

describe('a wheel version is fixed once written (point 4)', () => {
  it('is never changed or deleted, nor are its prizes', async () => {
    await expect(cross.$executeRawUnsafe(`UPDATE engagement.spin_wheel_config SET "dailyBudgetCapAmount" = 1 WHERE id = '${WHEEL_A}'`)).rejects.toThrow(/spin_wheel_is_history/);
    await expect(cross.$executeRawUnsafe(`DELETE FROM engagement.spin_wheel_config WHERE id = '${WHEEL_B}'`)).rejects.toThrow(/spin_wheel_is_history/);
    await expect(cross.$executeRawUnsafe(`UPDATE engagement.spin_wheel_prize SET "probabilityWeight" = 99 WHERE id = '${GB_PRIZE}'`)).rejects.toThrow(/spin_wheel_is_history/);
  });

  it('takes its prizes only in the transaction that wrote it', async () => {
    await expect(owner.$executeRawUnsafe(prize('99999999-9999-4999-8999-9999999999a9', WHEEL_A, 3, GB))).rejects.toThrow(/spin_wheel_is_history/);
  });

  it("refuses another tenant's user group", async () => {
    await expect(owner.$executeRawUnsafe(version('88888888-8888-4888-8888-8888888888a9', TENANT_A, 9, GROUP_B))).rejects.toThrow(/engagement_tenant_mismatch/);
  });
});

describe('no row pays cash, and each prize has its shape (point 2)', () => {
  let n = 0;
  const tryPrize = (shape: string) => (n += 1) &&
    owner.$transaction([
      owner.$executeRawUnsafe(version(`88888888-8888-4888-8888-88888888880${n}`, TENANT_A, 10 + n)),
      owner.$executeRawUnsafe(prize(`99999999-9999-4999-8999-99999999990${n}`, `88888888-8888-4888-8888-88888888880${n}`, 1, shape)),
    ]);

  it.each([
    ['a wallet credit', `'wallet_credit', 5, 5, NULL, NULL, NULL, NULL`],
    ['a coupon with no template', `'discount_coupon', 20, 5, NULL, 7, NULL, NULL`],
    ['a free Grant with no variant', `'free_grant', 1, 5, NULL, NULL, NULL, NULL`],
    ['an empty slot that costs', `'empty', 0, 5, NULL, NULL, NULL, NULL`],
    ['part of a day', `'extra_days', 1.5, 5, NULL, NULL, NULL, NULL`],
  ])('refuses %s', async (_name, shape) => {
    await expect(tryPrize(shape)).rejects.toThrow(/engagement_prize_shape/);
  });
});

describe("the day's counters (point 4)", () => {
  const day = (cost: number, wheel = WHEEL_A) =>
    owner.$executeRawUnsafe(`
      INSERT INTO engagement.spin_wheel_day ("tenantId", "tenantDay", "wheelConfigId", "costSpent", "currencyCode")
      VALUES ('${TENANT_A}', '${DAY}', '${wheel}', ${cost}, 'IRT')
      ON CONFLICT ("tenantId", "tenantDay") DO UPDATE SET "costSpent" = EXCLUDED."costSpent"`);

  it('never spend past the version cap, whatever the odds', async () => {
    await expect(day(100)).resolves.toBe(1);
    await expect(day(100.01)).rejects.toThrow(/spin_wheel_over_cap/);
  });

  it('never award a prize past its stock', async () => {
    const stock = (n: number) =>
      owner.$executeRawUnsafe(`
        INSERT INTO engagement.spin_wheel_prize_day ("prizeId", "tenantDay", "tenantId", "awardedCount") VALUES ('${GB_PRIZE}', '${DAY}', '${TENANT_A}', ${n})
        ON CONFLICT ("prizeId", "tenantDay") DO UPDATE SET "awardedCount" = EXCLUDED."awardedCount"`);
    await expect(stock(3)).resolves.toBe(1);
    await expect(stock(4)).rejects.toThrow(/spin_wheel_out_of_stock/);
  });
});

describe('a spin attempt', () => {
  it("holds its place in the user's day once — a database unique, not a read", async () => {
    await expect(attempt({ seq: 1 })).resolves.toBe(1);
    await expect(attempt({ seq: 1 })).rejects.toThrow(/Unique constraint|23505/);
    await expect(attempt({ seq: 2, key: 'retry-1' })).resolves.toBe(1);
    await expect(attempt({ seq: 3, key: 'retry-1' })).rejects.toThrow(/Unique constraint|23505/);
  });

  it('is recorded when refused, holding no place and no prize', async () => {
    await expect(attempt({ status: 'rejected_ineligible', seq: null })).resolves.toBe(1);
    await expect(attempt({ status: 'rejected_ineligible', seq: null })).resolves.toBe(1);
    await expect(attempt({ status: 'rejected_ineligible', seq: 4 })).rejects.toThrow(/spin_wheel_attempt_shape/);
    await expect(attempt({ status: 'awarded', seq: null })).rejects.toThrow(/spin_wheel_attempt_shape/);
    await expect(attempt({ status: 'rejected_ineligible', seq: null, reason: null })).rejects.toThrow(/spin_wheel_attempt_shape/);
  });

  it('is history', async () => {
    await expect(cross.$executeRawUnsafe(`UPDATE engagement.spin_wheel_attempt SET status = 'voided_fraud'`)).rejects.toThrow(/spin_wheel_attempt_is_history/);
    await expect(cross.$executeRawUnsafe(`DELETE FROM engagement.spin_wheel_attempt`)).rejects.toThrow(/spin_wheel_attempt_is_history/);
  });

  it("is its tenant's user's, on that user's fingerprint, with its own version's prize", async () => {
    await expect(attempt({ seq: null, status: 'rejected_ineligible', user: USER_B })).rejects.toThrow(/engagement_tenant_mismatch/);
    await expect(attempt({ seq: null, status: 'rejected_ineligible', user: USER_A2 })).rejects.toThrow(/engagement_tenant_mismatch/);
    await expect(attempt({ seq: 2, user: USER_A2, fp: FP_B })).rejects.toThrow(/engagement_tenant_mismatch/);
    await expect(attempt({ seq: 2, user: USER_A, key: 'other-version', awarded: V2_PRIZE })).rejects.toThrow(/engagement_tenant_mismatch/);
  });
});

describe('a lottery (point 5)', () => {
  const LOT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
  const exec = (sql: string) => owner.$executeRawUnsafe(sql);
  const setStatus = (status: string, extra = '') => exec(`UPDATE engagement.lottery SET status = '${status}'${extra} WHERE id = '${LOT}'`);
  const entrant = (userId: string) =>
    exec(`INSERT INTO engagement.lottery_entrant (id, "tenantId", "lotteryId", "userId") VALUES (gen_random_uuid(), '${TENANT_A}', '${LOT}', '${userId}')`);
  const lotteryPrize = (rank: number) =>
    exec(`
      INSERT INTO engagement.lottery_prize (id, "tenantId", "lotteryId", rank, label, "prizeType", "prizeValue", "winnersCount")
      VALUES (gen_random_uuid(), '${TENANT_A}', '${LOT}', ${rank}, 'GB', 'bonus_traffic_gb', 10, 1)`);
  const draw = () =>
    exec(`
      INSERT INTO engagement.lottery_draw ("lotteryId", "tenantId", "entrantCount", "listHash", "seedSealed", algorithm, "frozenAt", "drawnAt")
      VALUES ('${LOT}', '${TENANT_A}', 1, '${'a'.repeat(64)}', '{"kekId":"k1"}', 'hmac-sha256-fisher-yates-v1', now(), now())`);

  beforeAll(async () => {
    await exec(`
      INSERT INTO engagement.lottery (id, "tenantId", "userGroupId", title, "entryMode", "closesAt", "createdByAdminId")
      VALUES ('${LOT}', '${TENANT_A}', '${GROUP_A}', 'Draw', 'opt_in', now() + interval '1 day', '${ADMIN}')`);
  });

  it("names its own tenant's group, and refuses an empty or cash prize", async () => {
    await expect(
      exec(`
        INSERT INTO engagement.lottery (id, "tenantId", "userGroupId", title, "entryMode", "closesAt", "createdByAdminId")
        VALUES (gen_random_uuid(), '${TENANT_A}', '${GROUP_B}', 'X', 'automatic', now(), '${ADMIN}')`),
    ).rejects.toThrow(/engagement_tenant_mismatch/);
    await expect(
      exec(`
        INSERT INTO engagement.lottery_prize (id, "tenantId", "lotteryId", rank, label, "prizeType", "prizeValue", "winnersCount")
        VALUES (gen_random_uuid(), '${TENANT_A}', '${LOT}', 9, 'X', 'empty', 0, 1)`),
    ).rejects.toThrow(/engagement_prize_shape/);
  });

  it('is frozen once published: its time and prizes stay', async () => {
    await expect(lotteryPrize(1)).resolves.toBe(1);
    await expect(entrant(USER_A)).resolves.toBe(1);
    await expect(setStatus('published', `, "publishedAt" = now()`)).resolves.toBe(1);
    await expect(exec(`UPDATE engagement.lottery SET "closesAt" = now() + interval '9 days' WHERE id = '${LOT}'`)).rejects.toThrow(/lottery_frozen/);
    await expect(lotteryPrize(2)).rejects.toThrow(/lottery_frozen/);
    await expect(entrant(USER_A2)).resolves.toBe(1);
  });

  it('takes each user once', async () => {
    await expect(entrant(USER_A)).rejects.toThrow(/Unique constraint|23505/);
    await expect(entrant(USER_B)).rejects.toThrow(/engagement_tenant_mismatch/);
  });

  it('is cancelled only with a public reason', async () => {
    await expect(setStatus('cancelled', `, "cancelledAt" = now()`)).rejects.toThrow(/lottery_cancel_reason/);
  });

  it('is drawn once, and its seed is never rewritten', async () => {
    await expect(setStatus('frozen')).resolves.toBe(1);
    await expect(entrant(USER_A3)).rejects.toThrow(/lottery_frozen/);
    await expect(draw()).resolves.toBe(1);
    await expect(draw()).rejects.toThrow(/Unique constraint|23505/);
    await expect(exec(`UPDATE engagement.lottery_draw SET "seedSealed" = '{"kekId":"k2"}' WHERE "lotteryId" = '${LOT}'`)).rejects.toThrow(/lottery_draw_is_history/);
    await expect(exec(`UPDATE engagement.lottery_draw SET "publishedAt" = now() WHERE "lotteryId" = '${LOT}'`)).resolves.toBe(1);
    await expect(exec(`UPDATE engagement.lottery_draw SET "publishedAt" = now() WHERE "lotteryId" = '${LOT}'`)).rejects.toThrow(/lottery_draw_is_history/);
  });

  it('moves one way', async () => {
    await expect(setStatus('drawn')).resolves.toBe(1);
    await expect(setStatus('published')).rejects.toThrow(/lottery_status_one_way/);
    await expect(setStatus('cancelled', `, "cancelledAt" = now(), "cancelReason" = 'late'`)).rejects.toThrow(/lottery_status_one_way/);
  });
});
