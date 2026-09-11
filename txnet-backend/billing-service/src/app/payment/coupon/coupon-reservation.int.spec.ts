/**
 * Coupon reservation (F-092-h), against a real Postgres built from the
 * committed migration history.
 *
 * What only a database can say:
 *
 *   - The last slot. Legacy counted, then wrote, so two buyers both took it.
 *     Here the second reservation waits on the coupon row and then sees the
 *     first one's hold — one lands, the other is `capacity_reached`.
 *   - The per-user limit (billing invariant 6), the same race by one user.
 *   - A platform coupon (`tenantId` NULL). A tenant's connection may read it
 *     but its RLS `WITH CHECK` refuses any update of it, so the counters move
 *     only through the migration's functions (ADR-0040).
 *   - Confirm and release move the counters once, whatever calls them twice.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  runWithTenant,
  tenantTransaction,
  TenantContextMissing,
  TenantScopeConflict,
  withTenant,
} from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CouponReservation,
  CouponReservationRefused,
  CouponReservationService,
} from './coupon-reservation';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';

// id suffix, tenant, code, totalUsageLimit, perUserUsageLimit
const COUPONS: Array<[string, string | null, string, number | null, number]> = [
  ['b1', TENANT_A, 'LASTSLOT', 1, 0],
  ['b2', TENANT_A, 'ONCEEACH', null, 1],
  ['b3', null, 'PLATFORM', 5, 0],
  ['b4', TENANT_B, 'BETAONLY', null, 0],
  ['b5', TENANT_A, 'LIFECYCLE', 1, 0],
];

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
const reservations = new CouponReservationService();

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = new PrismaClient({ datasourceUrl: pg.ownerUrl });

  for (const [id, slug] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  for (const [suffix, tenantId, code, total, perUser] of COUPONS) {
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "totalUsageLimit", "perUserUsageLimit", "createdByAdminId")
      VALUES ('${couponId(suffix)}', ${tenantId ? `'${tenantId}'` : 'NULL'}, '${code}', 'percentage', 10.00, ${total ?? 'NULL'}, ${perUser}, '${ADMIN}')
    `);
  }

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

function couponId(suffix: string) {
  return `77777777-7777-4777-8777-7777777777${suffix}`;
}

let orders = 0;
function nextOrder() {
  orders += 1;
  return `99999999-9999-4999-8999-${String(orders).padStart(12, '0')}`;
}

function reservationOf(suffix: string, userId: string, orderReferenceId = nextOrder()): CouponReservation {
  const code = COUPONS.find(([s]) => s === suffix)![2];
  return {
    userId,
    orderReferenceId,
    applied: [{ couponId: couponId(suffix), code, discount: new Prisma.Decimal('2.00') }],
  };
}

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

const counters = (suffix: string) =>
  owner.coupon.findUniqueOrThrow({
    where: { id: couponId(suffix) },
    select: { usedCount: true, reservedCount: true },
  });

const redemptions = (suffix: string) =>
  owner.couponRedemption.findMany({
    where: { couponId: couponId(suffix) },
    select: { userId: true, status: true },
  });

/**
 * The first reservation lands and holds its transaction open; the second starts
 * only then, and is given time to finish before the first commits. A
 * count-then-write implementation finishes it in that time, on a count that
 * cannot see the uncommitted hold, and both land.
 */
async function raceWhileFirstIsOpen(first: CouponReservation, second: CouponReservation) {
  let commitFirst!: () => void;
  const held = new Promise<void>((resolve) => (commitFirst = resolve));
  let reservedFirst!: () => void;
  const firstIn = new Promise<void>((resolve) => (reservedFirst = resolve));

  const a = asTenant(TENANT_A, async (tx) => {
    await reservations.reserve(tx, first);
    reservedFirst();
    await held;
  });
  await firstIn;
  const b = asTenant(TENANT_A, (tx) => reservations.reserve(tx, second));
  await new Promise((resolve) => setTimeout(resolve, 500));
  commitFirst();
  return Promise.allSettled([a, b]);
}

function refusal(result: PromiseSettledResult<unknown>) {
  expect(result.status).toBe('rejected');
  const reason = (result as PromiseRejectedResult).reason;
  expect(reason).toBeInstanceOf(CouponReservationRefused);
  return reason as CouponReservationRefused;
}

it('gives the last slot to one buyer and refuses the other', async () => {
  const [first, second] = await raceWhileFirstIsOpen(
    reservationOf('b1', USER),
    reservationOf('b1', OTHER_USER),
  );

  expect(first.status).toBe('fulfilled');
  expect(refusal(second)).toMatchObject({ code: 'LASTSLOT', reason: 'capacity_reached' });
  await expect(counters('b1')).resolves.toEqual({ usedCount: 0, reservedCount: 1 });
  await expect(redemptions('b1')).resolves.toEqual([{ userId: USER, status: 'pending' }]);
});

it('holds one user to perUserUsageLimit when the same user reserves twice at once', async () => {
  const [first, second] = await raceWhileFirstIsOpen(
    reservationOf('b2', USER),
    reservationOf('b2', USER),
  );

  expect(first.status).toBe('fulfilled');
  expect(refusal(second)).toMatchObject({ code: 'ONCEEACH', reason: 'per_user_limit_reached' });
  // A refusal takes nothing: the counter moved for the one hold only.
  await expect(counters('b2')).resolves.toEqual({ usedCount: 0, reservedCount: 1 });
  await expect(redemptions('b2')).resolves.toHaveLength(1);

  // Another user is not limited by this user's hold.
  await asTenant(TENANT_A, (tx) => reservations.reserve(tx, reservationOf('b2', OTHER_USER)));
  await expect(counters('b2')).resolves.toEqual({ usedCount: 0, reservedCount: 2 });
});

it("reserves a platform coupon from a tenant's connection, and never another tenant's", async () => {
  await asTenant(TENANT_A, (tx) => reservations.reserve(tx, reservationOf('b3', USER)));
  await expect(counters('b3')).resolves.toEqual({ usedCount: 0, reservedCount: 1 });

  await expect(
    asTenant(TENANT_A, (tx) => reservations.reserve(tx, reservationOf('b4', USER))),
  ).rejects.toMatchObject({ code: 'BETAONLY', reason: 'not_found' });
  await expect(counters('b4')).resolves.toEqual({ usedCount: 0, reservedCount: 0 });
  await expect(redemptions('b4')).resolves.toEqual([]);
});

it('confirms and releases once, and a confirmed use is never given back', async () => {
  const cancelled = nextOrder();
  await asTenant(TENANT_A, (tx) => reservations.reserve(tx, reservationOf('b5', USER, cancelled)));

  await expect(
    asTenant(TENANT_A, (tx) => reservations.release(tx, cancelled, 'cancelled')),
  ).resolves.toBe(1);
  await expect(
    asTenant(TENANT_A, (tx) => reservations.release(tx, cancelled, 'expired')),
  ).resolves.toBe(0);
  await expect(counters('b5')).resolves.toEqual({ usedCount: 0, reservedCount: 0 });

  // The released slot is free again.
  const paid = nextOrder();
  await asTenant(TENANT_A, (tx) => reservations.reserve(tx, reservationOf('b5', OTHER_USER, paid)));
  await expect(asTenant(TENANT_A, (tx) => reservations.confirm(tx, paid))).resolves.toBe(1);
  await expect(asTenant(TENANT_A, (tx) => reservations.confirm(tx, paid))).resolves.toBe(0);
  await expect(
    asTenant(TENANT_A, (tx) => reservations.release(tx, paid, 'expired')),
  ).resolves.toBe(0);

  await expect(counters('b5')).resolves.toEqual({ usedCount: 1, reservedCount: 0 });
  await expect(redemptions('b5')).resolves.toEqual(
    expect.arrayContaining([
      { userId: USER, status: 'cancelled' },
      { userId: OTHER_USER, status: 'confirmed' },
    ]),
  );
  // Used up: a confirmed use holds its slot.
  await expect(
    asTenant(TENANT_A, (tx) => reservations.reserve(tx, reservationOf('b5', USER))),
  ).rejects.toMatchObject({ reason: 'capacity_reached' });
});

it('refuses to reserve outside a tenantTransaction', async () => {
  // Unbound, the functions would see only the platform's coupons — a wrong answer, not an error.
  await expect(
    runWithTenant({ id: TENANT_A }, () =>
      app.$transaction((tx) => reservations.reserve(tx, reservationOf('b3', USER))),
    ),
  ).rejects.toBeInstanceOf(TenantScopeConflict);
  await expect(
    app.$transaction((tx) => reservations.reserve(tx, reservationOf('b3', USER))),
  ).rejects.toBeInstanceOf(TenantContextMissing);
});
