/**
 * Gift code redemption (F-092-m), against a real Postgres built from the
 * committed migration history.
 *
 * A gift code is a `wallet_credit` coupon (D-21). It has no order to wait for,
 * so unlike a discount it is taken and used in one step — and that step must
 * commit with the wallet credit it causes, or a code is spent for nothing.
 * What only a database can say:
 *
 *   - The credit and the use are one transaction. The ledger row, its
 *     `balanceAfter`, the `confirmed` redemption and `usedCount` all move
 *     together (billing invariants 1-3, 11).
 *   - The last slot, and the per-user limit (invariant 6), under a race. The
 *     coupon row is locked first, as `reserve_coupon` locks it.
 *   - A platform coupon (`tenantId` NULL) redeems from a tenant's connection,
 *     whose RLS `WITH CHECK` refuses to update it directly (ADR-0040).
 *   - A discount coupon typed into the gift box is refused and credits
 *     nothing — the mirror of validation's `not_a_discount`.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerEntry, WalletLedgerService } from '../../wallet/wallet-ledger.service';
import { GiftCodeRefused, GiftRedemptionService } from './gift-redemption.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const ROLE = '66666666-6666-4666-8666-666666666666';

const user = (n: number) => `44444444-4444-4444-8444-4444444444${String(n).padStart(2, '0')}`;

// id suffix, tenant, code, discountType, discountValue, totalUsageLimit, perUserUsageLimit
const COUPONS: Array<[string, string | null, string, string, string, number | null, number]> = [
  ['e1', TENANT_A, 'GIFTPLAIN', 'wallet_credit', '12.34', null, 0],
  ['e2', TENANT_A, 'GIFTLAST', 'wallet_credit', '10.00', 1, 0],
  ['e3', TENANT_A, 'GIFTONCE', 'wallet_credit', '5.00', null, 1],
  ['e4', null, 'GIFTGLOBAL', 'wallet_credit', '7.50', 5, 0],
  ['e5', TENANT_B, 'GIFTBETA', 'wallet_credit', '3.00', null, 0],
  ['e6', TENANT_A, 'DISCOUNT10', 'percentage', '10.00', null, 0],
];

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let gifts: GiftRedemptionService;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = new PrismaClient({ datasourceUrl: pg.ownerUrl });

  for (const [id, slug] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  // `wallet.ownerUserId` is a foreign key: a credit opens a wallet, and a
  // wallet needs a user. Every test's user is seeded, including the ones no
  // test expects to be credited — a missing row would otherwise fail a
  // refusal test for the wrong reason.
  await owner.$executeRawUnsafe(`
    INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'harness_user', false)
  `);
  for (let n = 1; n <= 8; n += 1) {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES ('${user(n)}', '${TENANT_A}', 'harness ${n}', 'x', '${ROLE}', now())
    `);
  }
  for (const [suffix, tenantId, code, type, value, total, perUser] of COUPONS) {
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "totalUsageLimit", "perUserUsageLimit", "createdByAdminId")
      VALUES ('${couponId(suffix)}', ${tenantId ? `'${tenantId}'` : 'NULL'}, '${code}', '${type}', ${value}, ${total ?? 'NULL'}, ${perUser}, '${ADMIN}')
    `);
  }

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  gifts = new GiftRedemptionService(app, new WalletLedgerService());
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

function couponId(suffix: string) {
  return `77777777-7777-4777-8777-7777777777${suffix}`;
}

const codeOf = (suffix: string) => COUPONS.find(([s]) => s === suffix)![2];

const asTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant({ id: tenantId }, fn);

const redeem = (tenantId: string, suffix: string, userId: string) =>
  asTenant(tenantId, () => gifts.redeem({ userId, code: codeOf(suffix) }));

const counters = (suffix: string) =>
  owner.coupon.findUniqueOrThrow({
    where: { id: couponId(suffix) },
    select: { usedCount: true, reservedCount: true },
  });

const balanceOf = async (userId: string) =>
  (await owner.wallet.findUnique({ where: { ownerUserId: userId }, select: { cachedBalance: true } }))
    ?.cachedBalance.toFixed(2) ?? null;

const ledgerOf = async (userId: string) =>
  owner.walletTransaction.findMany({
    where: { wallet: { ownerUserId: userId } },
    select: { amount: true, direction: true, reasonType: true, referenceId: true, balanceAfter: true },
  });

it('credits the wallet by the code\'s value and marks the redemption used, in one transaction', async () => {
  const u = user(1);
  const result = await redeem(TENANT_A, 'e1', u);

  expect(result.code).toBe('GIFTPLAIN');
  expect(result.credited.toFixed(2)).toBe('12.34');
  expect(result.balanceAfter.toFixed(2)).toBe('12.34');
  await expect(balanceOf(u)).resolves.toBe('12.34');

  // The ledger row names the redemption it came from, not the coupon: a coupon
  // may be redeemed again, a redemption row never is.
  const ledger = await ledgerOf(u);
  expect(ledger).toHaveLength(1);
  expect(ledger[0].direction).toBe('credit');
  expect(ledger[0].reasonType).toBe('coupon_redemption');
  expect(ledger[0].referenceId).toBe(result.redemptionId);
  expect(ledger[0].amount.toFixed(2)).toBe('12.34');
  expect(ledger[0].balanceAfter.toFixed(2)).toBe('12.34');

  // Used, not held: there is nothing left to confirm later.
  await expect(counters('e1')).resolves.toEqual({ usedCount: 1, reservedCount: 0 });
  const redemption = await owner.couponRedemption.findFirstOrThrow({ where: { id: result.redemptionId } });
  expect(redemption).toMatchObject({ userId: u, status: 'confirmed', couponId: couponId('e1') });
  expect(redemption.discountAppliedAmount.toFixed(2)).toBe('12.34');
});

/**
 * The first redemption takes its slot and then holds its transaction open — it
 * is stalled inside the ledger, which is the real code path's next step. The
 * second starts only then, and is given time to finish before the first
 * commits. Without the row lock the second's gates run on a count that cannot
 * see the uncommitted use, and both land.
 */
async function raceWhileFirstIsOpen(suffix: string, first: string, second: string) {
  let commitFirst!: () => void;
  const held = new Promise<void>((resolve) => (commitFirst = resolve));
  let tookSlot!: () => void;
  const firstIn = new Promise<void>((resolve) => (tookSlot = resolve));

  const stalling = new GiftRedemptionService(
    app,
    new (class extends WalletLedgerService {
      override credit(tx: Prisma.TransactionClient, entry: LedgerEntry) {
        tookSlot();
        return held.then(() => super.credit(tx, entry));
      }
    })(),
  );

  const a = asTenant(TENANT_A, () => stalling.redeem({ userId: first, code: codeOf(suffix) }));
  await firstIn;
  const b = redeem(TENANT_A, suffix, second);
  await new Promise((resolve) => setTimeout(resolve, 500));
  commitFirst();
  return Promise.allSettled([a, b]);
}

it('gives the last slot to one user and credits nothing to the other', async () => {
  const [a, b] = [user(2), user(3)];
  const [first, second] = await raceWhileFirstIsOpen('e2', a, b);

  expect(first.status).toBe('fulfilled');
  expect(second.status).toBe('rejected');
  const refused = (second as PromiseRejectedResult).reason;
  expect(refused).toBeInstanceOf(GiftCodeRefused);
  expect(refused).toMatchObject({ code: 'GIFTLAST', reason: 'capacity_reached' });

  await expect(balanceOf(a)).resolves.toBe('10.00');
  // A refusal rolls its transaction back: no wallet is even opened.
  await expect(balanceOf(b)).resolves.toBe(null);
  await expect(counters('e2')).resolves.toEqual({ usedCount: 1, reservedCount: 0 });
});

it('holds one user to perUserUsageLimit under a race, and does not hold another user to it', async () => {
  const [u, other] = [user(4), user(5)];
  const [first, second] = await raceWhileFirstIsOpen('e3', u, u);

  expect(first.status).toBe('fulfilled');
  expect((second as PromiseRejectedResult).reason).toMatchObject({
    code: 'GIFTONCE',
    reason: 'per_user_limit_reached',
  });
  // Credited once, and the second attempt left no half of itself behind.
  await expect(balanceOf(u)).resolves.toBe('5.00');
  await expect(ledgerOf(u)).resolves.toHaveLength(1);

  await redeem(TENANT_A, 'e3', other);
  await expect(balanceOf(other)).resolves.toBe('5.00');
  await expect(counters('e3')).resolves.toEqual({ usedCount: 2, reservedCount: 0 });
});

it("redeems a platform code from a tenant's connection, and never another tenant's", async () => {
  const u = user(6);
  await redeem(TENANT_A, 'e4', u);
  await expect(balanceOf(u)).resolves.toBe('7.50');
  await expect(counters('e4')).resolves.toEqual({ usedCount: 1, reservedCount: 0 });

  await expect(redeem(TENANT_A, 'e5', u)).rejects.toMatchObject({
    code: 'GIFTBETA',
    reason: 'not_found',
  });
  await expect(balanceOf(u)).resolves.toBe('7.50');
  await expect(counters('e5')).resolves.toEqual({ usedCount: 0, reservedCount: 0 });
});

it('refuses a discount coupon typed into the gift box, and credits nothing', async () => {
  const u = user(7);
  await expect(redeem(TENANT_A, 'e6', u)).rejects.toMatchObject({
    code: 'DISCOUNT10',
    reason: 'not_a_gift_code',
  });
  await expect(balanceOf(u)).resolves.toBe(null);
  await expect(counters('e6')).resolves.toEqual({ usedCount: 0, reservedCount: 0 });
});

it('refuses an unknown code without opening a wallet', async () => {
  const u = user(8);
  await expect(asTenant(TENANT_A, () => gifts.redeem({ userId: u, code: '  no-such-code ' }))).rejects.toMatchObject({
    reason: 'not_found',
  });
  await expect(balanceOf(u)).resolves.toBe(null);
});
