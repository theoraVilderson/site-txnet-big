/**
 * The deposit quote and gateway list the panel renders (F-092-o).
 *
 * What would break silently here, and nowhere else:
 *  - an automatic-fee gateway's quote: the provider is asked in the gateway
 *    currency's minor unit, at the rate the payment will be charged at, and its
 *    answer comes back to base currency rounded **up** — a 1-rial fee is a cent,
 *    never zero;
 *  - the free path never reaches the provider or the vault;
 *  - the list carries the columns a selector needs and nothing else — a
 *    `tenant_gateway_config` row holds deprecated secret columns (invariant 8).
 *
 * The calculator's own rules are `gateway-pricing.spec.ts`; which rows are
 * selectable under RLS is `deposit-gateways.int.spec.ts`.
 */
import { Prisma } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import type { CouponValidation } from '../coupon/coupon-validation';
import { DepositGatewayNotFound, DepositQuoteService } from './deposit-quote.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '99999999-9999-4999-8999-999999999999';

const d = (v: string) => new Prisma.Decimal(v);

function gatewayRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GATEWAY,
    tenantId: TENANT,
    displayName: 'Zarinpal',
    providerName: 'zarinpal',
    gatewayCategory: 'domestic_rial',
    merchantIdEncrypted: 'SECRET-MERCHANT',
    apiKeyEncrypted: 'SECRET-KEY',
    verificationStatus: 'verified',
    verifiedByAdminId: null,
    isActive: true,
    minAcceptAmount: d('1.00'),
    maxAcceptAmount: d('1000.00'),
    feeCalculationMode: 'manual',
    feeType: 'percentage',
    feeValue: d('1.0000'),
    feeFloor: null,
    feeCeiling: null,
    useLiveRate: true,
    staticRate: d('1000000'),
    percentageModifier: d('0'),
    fixedAmountModifier: d('0'),
    minRate: null,
    maxRate: null,
    roundingStep: null,
    roundingMode: 'up',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

const noCoupons = (amount: string): CouponValidation => ({
  applied: [],
  rejected: [],
  totalDiscount: d('0'),
  payable: d(amount),
});

type Setup = {
  rows?: ReturnType<typeof gatewayRow>[];
  coupons?: CouponValidation;
  quoteFee?: (amountMinor: bigint) => bigint;
};

function build({ rows = [gatewayRow()], coupons = noCoupons('20.00'), quoteFee }: Setup = {}) {
  const tx = {
    $executeRaw: async () => 0,
    tenant: { findUnique: async () => ({ tenantType: 'reseller' }) },
    tenantGatewayConfig: {
      findFirst: async () => rows[0] ?? null,
      findMany: async () => rows,
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const zarinpal = {
    name: 'zarinpal',
    chargeCurrency: 'IRR',
    chargeDecimals: 0,
    quoteFee: async ({ amountMinor }: { amountMinor: bigint }) => {
      if (!quoteFee) throw new Error('the provider must not be asked for a fee here');
      return { feeMinor: quoteFee(amountMinor) };
    },
  };
  const registry = {
    has: (name: string) => name === 'zarinpal',
    get: (name: string) => {
      if (name !== 'zarinpal') throw new Error(`no driver for ${name}`);
      return zarinpal;
    },
  };
  const merchant = {
    credentialsFor: async () => {
      if (!quoteFee) throw new Error('the vault must not be read here');
      return { merchantId: 'merchant' };
    },
  };
  const couponService = { validate: async () => coupons };
  return new DepositQuoteService(
    prisma as never,
    couponService as never,
    registry as never,
    merchant as never,
  );
}

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);

describe('DepositQuoteService.quote', () => {
  it('breaks a manual-fee deposit down the way the gateway will charge it', async () => {
    const service = build({
      coupons: {
        applied: [{ couponId: 'c1', code: 'SAVE5', discount: d('5.00') }],
        rejected: [{ code: 'OLD', reason: 'expired' }],
        totalDiscount: d('5.00'),
        payable: d('15.00'),
      },
    });

    const quote = await asTenant(() =>
      service.quote({ userId: USER, gatewayId: GATEWAY, source: 'tenant', amount: d('20.00'), couponCodes: ['save5', 'old'] }),
    );

    expect(quote).toEqual({
      gatewayId: GATEWAY,
      source: 'tenant',
      amount: '20.00',
      coupons: [{ code: 'SAVE5', discount: '5.00' }],
      rejected: [{ code: 'OLD', reason: 'expired' }],
      discount: '5.00',
      gap: '0.00',
      fee: '0.15',
      payable: '15.15',
      credited: '20.00',
      free: false,
      charge: { currency: 'IRR', decimals: 0, amountMinor: '15150000' },
    });
    // The wire is JSON: a bigint in the answer would throw at serialisation.
    expect(() => JSON.stringify(quote)).not.toThrow();
  });

  it("asks an automatic-fee provider in its minor unit and converts the answer back at the charge rate", async () => {
    const service = build({
      rows: [gatewayRow({ feeCalculationMode: 'automatic', staticRate: d('600000') })],
      coupons: noCoupons('10.00'),
      quoteFee: (amountMinor) => amountMinor / BigInt(100), // 1% of what it is asked about
    });

    const quote = await asTenant(() =>
      service.quote({ userId: USER, gatewayId: GATEWAY, source: 'tenant', amount: d('10.00'), couponCodes: [] }),
    );

    // 10.00 at 600000 is 6,000,000 rial; 1% is 60,000 rial, which is 0.10.
    expect(quote.fee).toBe('0.10');
    expect(quote.payable).toBe('10.10');
    expect(quote.charge).toEqual({ currency: 'IRR', decimals: 0, amountMinor: '6060000' });
  });

  it('rounds a provider fee up to the cent, never down to nothing', async () => {
    const service = build({
      rows: [gatewayRow({ feeCalculationMode: 'automatic', staticRate: d('600000') })],
      coupons: noCoupons('10.00'),
      quoteFee: () => BigInt(1),
    });

    const quote = await asTenant(() =>
      service.quote({ userId: USER, gatewayId: GATEWAY, source: 'tenant', amount: d('10.00'), couponCodes: [] }),
    );

    expect(quote.fee).toBe('0.01');
  });

  it('prices a fully discounted deposit as free without asking the provider or the vault', async () => {
    const service = build({
      rows: [gatewayRow({ feeCalculationMode: 'automatic' })],
      coupons: {
        applied: [{ couponId: 'c1', code: 'ALL', discount: d('10.00') }],
        rejected: [],
        totalDiscount: d('10.00'),
        payable: d('0'),
      },
    });

    const quote = await asTenant(() =>
      service.quote({ userId: USER, gatewayId: GATEWAY, source: 'tenant', amount: d('10.00'), couponCodes: ['ALL'] }),
    );

    expect(quote).toMatchObject({ free: true, fee: '0.00', payable: '0.00', credited: '10.00', charge: null });
  });

  it('refuses a gateway the tenant cannot select', async () => {
    const service = build({ rows: [] });

    await expect(
      asTenant(() => service.quote({ userId: USER, gatewayId: GATEWAY, source: 'tenant', amount: d('10.00'), couponCodes: [] })),
    ).rejects.toBeInstanceOf(DepositGatewayNotFound);
  });
});

describe('DepositQuoteService.listGateways', () => {
  it('answers what a selector renders, never a secret column, and hides a provider with no driver', async () => {
    const service = build({
      rows: [gatewayRow(), gatewayRow({ id: 'idpay-row', providerName: 'idpay', displayName: 'IDPay' })],
    });

    const gateways = await asTenant(() => service.listGateways());

    expect(gateways).toEqual([
      {
        id: GATEWAY,
        source: 'tenant',
        displayName: 'Zarinpal',
        providerName: 'zarinpal',
        category: 'domestic_rial',
        minAmount: '1.00',
        maxAmount: '1000.00',
      },
    ]);
    expect(JSON.stringify(gateways)).not.toContain('SECRET');
  });
});
