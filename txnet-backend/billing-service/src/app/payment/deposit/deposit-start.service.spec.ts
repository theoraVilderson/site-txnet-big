/**
 * Starting a top-up (F-092-i) — the first billing route that writes money.
 *
 * What would break silently here, and nowhere else:
 *  - the order: coupons are held and the payment persisted **before** the
 *    gateway is asked for an authority, because `request` is never retried and
 *    every attempt mints one. A refusal after the bank has been called is an
 *    authority nobody will ever pay;
 *  - the payment carries the price it was quoted at, and the rate snapshot that
 *    priced it (invariant 12) — a rial invoice nobody can prove is ADR-0019's
 *    forbidden state;
 *  - the free path credits the wallet and confirms the holds in one
 *    transaction, and reaches neither the vault nor the provider;
 *  - a gateway that fails to mint leaves no live hold and no pending payment —
 *    the row is `failed` and the coupons are released.
 *
 * The breakdown itself is `deposit-quote.service.spec.ts` and
 * `gateway-pricing.spec.ts`; what a hold re-checks under its row lock is
 * `coupon-reservation.int.spec.ts`.
 */
import { Prisma } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import type { CouponValidation } from '../coupon/coupon-validation';
import { CouponReservationRefused } from '../coupon/coupon-reservation';
import { GatewayFailure } from '../gateway/payment-provider';
import { DepositGatewayNotFound } from './deposit-quote.service';
import { DepositCallbackUnavailable, DepositStartService } from './deposit-start.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '99999999-9999-4999-8999-999999999999';

const d = (v: string) => new Prisma.Decimal(v);

function gatewayRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GATEWAY,
    displayName: 'Zarinpal',
    providerName: 'zarinpal',
    gatewayCategory: 'domestic_rial',
    minAcceptAmount: d('1.00'),
    maxAcceptAmount: d('1000.00'),
    feeCalculationMode: 'manual',
    feeType: 'percentage',
    feeValue: d('1.0000'),
    feeFloor: null,
    feeCeiling: null,
    useLiveRate: false,
    staticRate: d('1000000'),
    percentageModifier: d('0'),
    fixedAmountModifier: d('0'),
    minRate: null,
    maxRate: null,
    roundingStep: null,
    roundingMode: 'up',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

const noCoupons = (amount: string): CouponValidation => ({
  applied: [],
  rejected: [],
  totalDiscount: d('0'),
  payable: d(amount),
});

type Calls = {
  created: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
  reserved: Array<{ orderReferenceId: string }>;
  settled: Array<{ orderReferenceId: string; outcome: string }>;
  credited: Array<{ amount: string; referenceId?: string }>;
  requested: Array<{ amountMinor: bigint; callbackUrl: string }>;
};

type Setup = {
  row?: ReturnType<typeof gatewayRow> | null;
  coupons?: CouponValidation;
  /** A hold that can no longer be taken — the refusal must abort everything. */
  reserveRefuses?: CouponReservationRefused;
  /** The gateway refuses to mint an authority. */
  requestFails?: Error;
  domains?: Array<{ domainValue: string; domainType: string; verificationStatus: string }>;
  callbackOrigin?: string;
};

function build(setup: Setup = {}) {
  const {
    row = gatewayRow(),
    coupons = noCoupons('20.00'),
    reserveRefuses,
    requestFails,
    domains = [{ domainValue: 'myvpn.txnet.app', domainType: 'subdomain', verificationStatus: 'pending' }],
    callbackOrigin = '',
  } = setup;

  const calls: Calls = { created: [], updated: [], reserved: [], settled: [], credited: [], requested: [] };
  let nextId = 0;

  const tx = {
    $executeRaw: async () => 0,
    tenant: { findUnique: async () => ({ tenantType: 'reseller' }) },
    // No grant: `selectGateway` looks for one only after the tenant's own row
    // misses, and `selectableGateways` always asks (F-096-b).
    paymentGatewayGrant: { findMany: async () => [] },
    tenantGatewayConfig: { findFirst: async () => row },
    // The filter and the order are the service's, so the fake applies the
    // `where` and `orderBy` it was handed rather than answering every row: what
    // is under test is which host the service asks for, and an unproven custom
    // domain is excluded by that `where` and nowhere else.
    tenantDomain: {
      findMany: async ({ where, orderBy }: { where: Record<string, any>; orderBy: Array<Record<string, string>> }) => {
        const matches = domains.filter(
          (r) =>
            where['purpose'] === 'panel' &&
            (where['OR'] as Array<Record<string, string>>).some(
              (or) => or['domainType'] === r.domainType || or['verificationStatus'] === r.verificationStatus,
            ),
        );
        const rank = (t: string) => (t === 'custom_domain' ? 0 : 1);
        expect(orderBy[0]).toEqual({ domainType: 'desc' });
        return [...matches].sort((a, b) => rank(a.domainType) - rank(b.domainType) || a.domainValue.localeCompare(b.domainValue));
      },
    },
    paymentTransaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.created.push(data);
        return { id: (data['id'] as string) ?? `payment-${++nextId}` };
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updated.push({ ...where, ...data });
        return { id: where['id'] };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };

  const zarinpal = {
    name: 'zarinpal',
    chargeCurrency: 'IRR',
    chargeDecimals: 0,
    quoteFee: async () => {
      throw new Error('a manual-fee gateway must not be asked for a fee');
    },
    request: async ({ amountMinor, callbackUrl }: { amountMinor: bigint; callbackUrl: string }) => {
      calls.requested.push({ amountMinor, callbackUrl });
      if (requestFails) throw requestFails;
      return { authority: 'A0000000000000000000000000000001', redirectUrl: 'https://zarinpal/StartPay/A000…01' };
    },
  };
  const registry = { has: () => true, get: () => zarinpal };
  const merchant = {
    credentialsFor: async () => ({ merchantId: 'merchant' }),
    requireConfigured: async () => undefined,
    configuredLabels: async () => new Set([`gateway:tenant:${GATEWAY}`]),
  };
  const reservations = {
    reserve: async (_tx: unknown, r: { orderReferenceId: string }) => {
      calls.reserved.push({ orderReferenceId: r.orderReferenceId });
      if (reserveRefuses) throw reserveRefuses;
    },
    confirm: async (_tx: unknown, orderReferenceId: string) => {
      calls.settled.push({ orderReferenceId, outcome: 'confirmed' });
      return 1;
    },
    release: async (_tx: unknown, orderReferenceId: string, outcome: string) => {
      calls.settled.push({ orderReferenceId, outcome });
      return 1;
    },
  };
  const ledger = {
    credit: async (_tx: unknown, entry: { amount: Prisma.Decimal; referenceId?: string }) => {
      calls.credited.push({ amount: entry.amount.toFixed(2), referenceId: entry.referenceId });
      return { balanceAfter: d('120.00') };
    },
  };
  const config = {
    get: (key: string) =>
      ({ GLOBAL_PREFIX: 'api', PAYMENT_CALLBACK_ORIGIN: callbackOrigin, PAYMENT_PENDING_TTL_SEC: 900 })[key],
  };

  const service = new DepositStartService(
    prisma as never,
    // No grant in this fixture: `tenantGatewayConfig.findMany` on the
    // cross-tenant pool is only reached for a gateway somebody granted
    // (F-096-b), and these cases are about a tenant's own.
    { tenantGatewayConfig: { findMany: async () => [] } } as never,
    { validate: async () => coupons } as never,
    reservations as never,
    registry as never,
    merchant as never,
    { current: async () => null } as never,
    ledger as never,
    config as never,
  );
  return { service, calls };
}

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);

const start = (service: DepositStartService, couponCodes: string[] = []) =>
  asTenant(() =>
    service.start({ userId: USER, gatewayId: GATEWAY, source: 'tenant', amount: d('20.00'), couponCodes }),
  );

describe('DepositStartService.start', () => {
  it('holds the coupons and persists the payment before the gateway is asked to mint', async () => {
    const { service, calls } = build({
      coupons: {
        applied: [{ couponId: 'c1', code: 'SAVE5', discount: d('5.00') }],
        rejected: [],
        totalDiscount: d('5.00'),
        payable: d('15.00'),
      },
    });

    const started = await start(service, ['save5']);

    expect(started.free).toBe(false);
    expect(started.redirectUrl).toBe('https://zarinpal/StartPay/A000…01');
    // The quote's own numbers, on the row (F-0612): 20 - 5, 1% fee.
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({
      userId: USER,
      tenantGatewayConfigId: GATEWAY,
      status: 'pending',
      chargedAmountMinor: BigInt(15_150_000),
    });
    expect((calls.created[0]['amountRequested'] as Prisma.Decimal).toFixed(2)).toBe('20.00');
    expect((calls.created[0]['discountApplied'] as Prisma.Decimal).toFixed(2)).toBe('5.00');
    expect((calls.created[0]['feeApplied'] as Prisma.Decimal).toFixed(2)).toBe('0.15');
    expect((calls.created[0]['amountCredited'] as Prisma.Decimal).toFixed(2)).toBe('20.00');
    // A `staticRate` gateway attributes no snapshot (invariant 12).
    expect(calls.created[0]['exchangeRateSnapshotId']).toBeNull();
    // The hold names the payment, so F-092-j and F-092-k can settle it by id.
    expect(calls.reserved).toEqual([{ orderReferenceId: started.paymentId }]);
    // …and it was written before the bank was called, not after.
    expect(calls.requested).toHaveLength(1);
    expect(calls.requested[0].amountMinor).toBe(BigInt(15_150_000));
    // The authority is the row's tracking code (ADR-0028), written once it exists.
    expect(calls.updated).toEqual([
      { id: started.paymentId, gatewayTrackingCode: 'A0000000000000000000000000000001' },
    ]);
  });

  it('sends the bank to the tenant\'s own panel domain, never the platform\'s', async () => {
    const { service, calls } = build({
      domains: [
        { domainValue: 'reseller.txnet.app', domainType: 'subdomain', verificationStatus: 'pending' },
        { domainValue: 'myvpn.com', domainType: 'custom_domain', verificationStatus: 'verified' },
      ],
    });

    await start(service);

    // ADR-0020: the callback is a public route resolved by Host, so a reseller's
    // customer must come back to the brand they paid on.
    expect(calls.requested[0].callbackUrl).toBe('https://myvpn.com/api/billing/deposit/callback');
  });

  it('refuses a tenant whose only custom domain is unproven, rather than guessing a host', async () => {
    const { service, calls } = build({
      domains: [{ domainValue: 'claimed.example', domainType: 'custom_domain', verificationStatus: 'pending' }],
    });

    await expect(start(service)).rejects.toBeInstanceOf(DepositCallbackUnavailable);
    // Nothing was minted and nothing was held.
    expect(calls.requested).toHaveLength(0);
    expect(calls.created).toHaveLength(0);
  });

  it('credits a fully discounted top-up at once, and reaches no gateway at all', async () => {
    const { service, calls } = build({
      coupons: {
        applied: [{ couponId: 'c1', code: 'ALLFREE', discount: d('20.00') }],
        rejected: [],
        totalDiscount: d('20.00'),
        payable: d('0.00'),
      },
    });

    const started = await start(service, ['allfree']);

    expect(started.free).toBe(true);
    expect(started.redirectUrl).toBeNull();
    expect(started.balance).toBe('120.00');
    expect(calls.requested).toEqual([]);
    expect(calls.created[0]).toMatchObject({ status: 'success', chargedAmountMinor: BigInt(0), expiresAt: null });
    // The credit names the payment, and the holds become uses in the same breath.
    expect(calls.credited).toEqual([{ amount: '20.00', referenceId: started.paymentId }]);
    expect(calls.settled).toEqual([{ orderReferenceId: started.paymentId, outcome: 'confirmed' }]);
  });

  it('writes nothing when a hold can no longer be taken', async () => {
    const { service, calls } = build({
      coupons: {
        applied: [{ couponId: 'c1', code: 'LAST', discount: d('5.00') }],
        rejected: [],
        totalDiscount: d('5.00'),
        payable: d('15.00'),
      },
      reserveRefuses: new CouponReservationRefused('LAST', 'capacity_reached'),
    });

    await expect(start(service, ['last'])).rejects.toBeInstanceOf(CouponReservationRefused);
    // The create rolls back with the transaction; what must not happen is the
    // bank being called for a payment the user is about to be told to re-quote.
    expect(calls.requested).toEqual([]);
  });

  it('fails the payment and gives the holds back when the gateway will not mint', async () => {
    const { service, calls } = build({
      coupons: {
        applied: [{ couponId: 'c1', code: 'SAVE5', discount: d('5.00') }],
        rejected: [],
        totalDiscount: d('5.00'),
        payable: d('15.00'),
      },
      requestFails: new GatewayFailure('zarinpal', 'merchant_rejected', '-9', 'merchant is suspended'),
    });

    await expect(start(service, ['save5'])).rejects.toBeInstanceOf(GatewayFailure);

    const paymentId = calls.created[0]['id'] as string;
    expect(calls.updated).toEqual([{ id: paymentId, status: 'failed', failureCode: 'merchant_rejected' }]);
    expect(calls.settled).toEqual([{ orderReferenceId: paymentId, outcome: 'cancelled' }]);
  });

  it('refuses a gateway this tenant cannot select, before anything is written', async () => {
    const { service, calls } = build({ row: null });

    await expect(start(service)).rejects.toBeInstanceOf(DepositGatewayNotFound);
    expect(calls.created).toEqual([]);
  });
});
