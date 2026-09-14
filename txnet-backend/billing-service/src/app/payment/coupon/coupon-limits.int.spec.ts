/**
 * A coupon's limits (F-502-j storage, F-502-k gates, D-33), against a real
 * Postgres built from the committed migration history.
 *
 * The storage half: every limit defaults to "none", so a coupon written before
 * F-502-j behaves as it did; and a limit that cannot mean anything — a
 * half-set window or period, an hour out of range, a maximum below the
 * minimum, a gateway row naming neither or both gateways — is refused by the
 * database rather than guessed at by a reader.
 *
 * The gates' half — only the facts a database holds: the user's account age,
 * whether they have paid before, how many uses fall inside the period, and the
 * coupon's gateway rows; and `reserve_coupon` refusing the start date, the
 * period limit and first purchase again under its row lock.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';
import { PrismaService } from '../../prisma/prisma.service';
import { CouponReservationService } from './coupon-reservation';
import { CouponValidationService } from './coupon-validation';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const ROLE = '66666666-6666-4666-8666-666666666666';
const GATEWAY = '88888888-8888-4888-8888-888888888888';
const OLD_USER = '44444444-4444-4444-8444-444444444401';
const NEW_USER = '44444444-4444-4444-8444-444444444402';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let seq = 0;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = new PrismaClient({ datasourceUrl: pg.ownerUrl });
  await owner.$executeRawUnsafe(`
    INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
    VALUES ('${TENANT}', 'reseller', '${TENANT}', 'alpha', 'active', 'pay_as_you_go_metered', now())
  `);
  await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'harness_user', false)`);
  for (const [id, age] of [[OLD_USER, '30 days'], [NEW_USER, '1 day']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "createdAt", "updatedAt")
      VALUES ('${id}', '${TENANT}', 'harness', 'x', '${ROLE}', now() - interval '${age}', now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.payment_gateway
      (id, "displayName", "providerName", "gatewayCategory", "supportedCurrencies", "merchantId",
       "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "updatedAt")
    VALUES ('${GATEWAY}', 'platform', 'zarinpal', 'domestic_rial', '["IRR"]', 'm', 1.00, 500.00, 'manual', 'percentage', 1.0000, now())
  `);
  // OLD_USER has paid once before; NEW_USER never has.
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.payment_transaction
      (id, "tenantId", "userId", "gatewayId", status, "amountRequested", "feeApplied", "discountApplied", "amountCredited",
       "chargedAmountMinor", "exchangeRateSnapshot")
    VALUES (gen_random_uuid(), '${TENANT}', '${OLD_USER}', '${GATEWAY}', 'success', 10.00, 0.00, 0.00, 10.00, 10000000, 1000000.00000000)
  `);

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect()]);
  await owner?.$disconnect();
  await pg?.stop();
});

/** Inserts a coupon with `columns` set on top of the minimum; resolves to its id. */
async function couponWith(columns: Record<string, string> = {}): Promise<string> {
  seq += 1;
  const id = `77777777-7777-4777-8777-7777777777${String(seq).padStart(2, '0')}`;
  const names = ['id', '"tenantId"', 'code', '"discountType"', '"discountValue"', '"createdByAdminId"', ...Object.keys(columns)];
  const values = [`'${id}'`, `'${TENANT}'`, `'LIMIT${seq}'`, `'percentage'`, '10.00', `'${ADMIN}'`, ...Object.values(columns)];
  await owner.$executeRawUnsafe(`INSERT INTO billing.coupon (${names.join(', ')}) VALUES (${values.join(', ')})`);
  return id;
}

describe('coupon limits: storage (F-502-j)', () => {
  it('defaults every limit to none', async () => {
    const id = await couponWith();
    await expect(
      owner.coupon.findUniqueOrThrow({
        where: { id },
        select: {
          validFrom: true,
          activeWeekdays: true,
          activeHourFrom: true,
          activeHourTo: true,
          maxPurchaseAmount: true,
          firstPurchaseOnly: true,
          newUserWithinDays: true,
          periodUsageLimit: true,
          periodDays: true,
          allowedChannels: true,
        },
      }),
    ).resolves.toEqual({
      validFrom: null,
      activeWeekdays: [],
      activeHourFrom: null,
      activeHourTo: null,
      maxPurchaseAmount: null,
      firstPurchaseOnly: false,
      newUserWithinDays: null,
      periodUsageLimit: null,
      periodDays: null,
      allowedChannels: [],
    });
  });

  it('keeps a full set of sensible limits, including a window that wraps midnight', async () => {
    await expect(
      couponWith({
        '"validFrom"': `'2026-09-01'`,
        '"expiresAt"': `'2026-10-01'`,
        '"activeWeekdays"': 'ARRAY[4,5]',
        '"activeHourFrom"': '22',
        '"activeHourTo"': '2',
        '"minPurchaseAmount"': '5.00',
        '"maxPurchaseAmount"': '50.00',
        '"firstPurchaseOnly"': 'true',
        '"newUserWithinDays"': '7',
        '"periodUsageLimit"': '2',
        '"periodDays"': '30',
        '"allowedChannels"': `ARRAY['bot']::billing."CouponChannel"[]`,
      }),
    ).resolves.toBeTruthy();
  });

  it.each([
    ['a weekday outside 1..7', { '"activeWeekdays"': 'ARRAY[0]' }, 'coupon_active_weekdays_iso'],
    ['half an hour window', { '"activeHourFrom"': '9' }, 'coupon_active_hours'],
    ['an hour past 24', { '"activeHourFrom"': '9', '"activeHourTo"': '25' }, 'coupon_active_hours'],
    ['an empty hour window', { '"activeHourFrom"': '9', '"activeHourTo"': '9' }, 'coupon_active_hours'],
    ['a maximum below the minimum', { '"minPurchaseAmount"': '10.00', '"maxPurchaseAmount"': '5.00' }, 'coupon_max_purchase'],
    ['a zero-day new-user window', { '"newUserWithinDays"': '0' }, 'coupon_new_user_days'],
    ['a period limit with no period', { '"periodUsageLimit"': '1' }, 'coupon_period_limit'],
    ['a start after the expiry', { '"validFrom"': `'2026-10-02'`, '"expiresAt"': `'2026-10-01'` }, 'coupon_valid_window'],
  ])('refuses %s', async (_name, columns, constraint) => {
    await expect(couponWith(columns)).rejects.toThrow(new RegExp(constraint));
  });

  it('refuses a gateway limit that names neither gateway, or both', async () => {
    const id = await couponWith();
    await expect(
      owner.$executeRawUnsafe(`INSERT INTO billing.coupon_gateway (id, "couponId") VALUES (gen_random_uuid(), '${id}')`),
    ).rejects.toThrow(/coupon_gateway_names_one/);
    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO billing.coupon_gateway (id, "couponId", "gatewayId", "tenantGatewayConfigId")
        VALUES (gen_random_uuid(), '${id}', gen_random_uuid(), gen_random_uuid())
      `),
    ).rejects.toThrow(/coupon_gateway_names_one/);
  });
});

describe('coupon limits: the gates a database answers (F-502-k)', () => {
  const validator = new CouponValidationService();
  const reservations = new CouponReservationService();

  const inTenant = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runWithTenant({ id: TENANT }, () => tenantTransaction(app, fn));

  const reasonFor = async (id: string, userId: string, extra: Record<string, unknown> = {}) => {
    const { code } = await owner.coupon.findUniqueOrThrow({ where: { id }, select: { code: true } });
    const r = await inTenant((tx) =>
      validator.validate(tx, {
        codes: [code],
        amount: new Prisma.Decimal('20.00'),
        target: { kind: 'wallet_top_up' },
        gatewaySource: 'platform',
        gatewayId: GATEWAY,
        channel: 'panel',
        userId,
        ...extra,
      }),
    );
    return r.rejected[0]?.reason ?? null;
  };

  const redeemedAgo = (couponId: string, userId: string, days: number) =>
    owner.$executeRawUnsafe(`
      INSERT INTO billing.coupon_redemption (id, "couponId", "userId", status, "discountAppliedAmount", "orderReferenceId", "redeemedAt")
      VALUES (gen_random_uuid(), '${couponId}', '${userId}', 'confirmed', 1.00, gen_random_uuid(), now() - interval '${days} days')
    `);

  const reserve = async (id: string, userId: string) => {
    const { code } = await owner.coupon.findUniqueOrThrow({ where: { id }, select: { code: true } });
    return inTenant((tx) =>
      reservations.reserve(tx, {
        userId,
        orderReferenceId: crypto.randomUUID(),
        applied: [{ couponId: id, code, discount: new Prisma.Decimal('2.00') }],
      }),
    );
  };

  it("reads the account's age for a new-user coupon", async () => {
    const id = await couponWith({ '"newUserWithinDays"': '7', '"perUserUsageLimit"': '0' });
    await expect(reasonFor(id, OLD_USER)).resolves.toBe('not_a_new_user');
    await expect(reasonFor(id, NEW_USER)).resolves.toBe(null);
  });

  it('reads a past success payment for a first-purchase coupon, and refuses it again under the lock', async () => {
    const id = await couponWith({ '"firstPurchaseOnly"': 'true', '"perUserUsageLimit"': '0' });
    await expect(reasonFor(id, OLD_USER)).resolves.toBe('first_purchase_only');
    await expect(reasonFor(id, NEW_USER)).resolves.toBe(null);
    await expect(reserve(id, OLD_USER)).rejects.toMatchObject({ reason: 'first_purchase_only' });
    await expect(reserve(id, NEW_USER)).resolves.toBeUndefined();
  });

  it('counts only the uses inside the period, and refuses the next one under the lock', async () => {
    const id = await couponWith({ '"periodUsageLimit"': '1', '"periodDays"': '30', '"perUserUsageLimit"': '0' });
    await redeemedAgo(id, NEW_USER, 45);
    await expect(reasonFor(id, NEW_USER)).resolves.toBe(null);
    await redeemedAgo(id, NEW_USER, 3);
    await expect(reasonFor(id, NEW_USER)).resolves.toBe('period_limit_reached');
    await expect(reserve(id, NEW_USER)).rejects.toMatchObject({ reason: 'period_limit_reached' });
  });

  it('refuses a coupon that has not started, in validation and in the hold', async () => {
    const id = await couponWith({ '"validFrom"': `now() + interval '1 day'` });
    await expect(reasonFor(id, NEW_USER)).resolves.toBe('not_started');
    await expect(reserve(id, NEW_USER)).rejects.toMatchObject({ reason: 'not_started' });
  });

  it('loads the gateway rows it is limited to', async () => {
    const id = await couponWith();
    await owner.$executeRawUnsafe(
      `INSERT INTO billing.coupon_gateway (id, "couponId", "gatewayId") VALUES (gen_random_uuid(), '${id}', '${GATEWAY}')`,
    );
    await expect(reasonFor(id, NEW_USER)).resolves.toBe(null);
    await expect(reasonFor(id, NEW_USER, { gatewayId: crypto.randomUUID() })).resolves.toBe('wrong_gateway');
  });
});
