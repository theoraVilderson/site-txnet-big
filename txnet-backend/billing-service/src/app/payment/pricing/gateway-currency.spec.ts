/**
 * F-116-e (ADR-0098 parts 2, 6): a deposit is priced from the payer's own
 * currency to the gateway's charge currency, and the payment records the pair.
 *
 * What would break silently here, and nowhere else:
 *  - a EUR tenant on a rial gateway charged at the USD->IRR rate — the rate the
 *    pricer read before this row, which is off by the whole EUR/USD factor;
 *  - a pair recorded by one leg: `exchangeRateSnapshotId` alone cannot say
 *    which EUR reading the charge crossed at, so the receipt cannot be re-explained;
 *  - a gateway charging the payer's own currency priced at anything but 1 —
 *    the old rule was "charges USD", which prices a EUR tenant's EUR card at
 *    the EUR rate and multiplies the charge by it;
 *  - an inverse pair (IRR -> USD, ~0.0000167) cut to 8 places, so the rate the
 *    row stores is not the rate the charge was computed at.
 *
 * The pair arithmetic is shared-core's `readFxPair` (`fx-rate.spec.ts`); the
 * calculator's own rules are `gateway-pricing.spec.ts`.
 */
import { Prisma } from '@prisma/client';

import { chargeCurrenciesOf, offeredInCurrency, priceDeposit, type SelectedGateway } from '../deposit/deposit-pricing';
import { FxRateReader } from './fx-rate.reader';
import { InvalidPricingInput } from './gateway-pricing';

const d = (v: string) => new Prisma.Decimal(v);

const IRR_ROW = '3c7e1f90-55aa-4b1d-88e1-77c0a2d4e002';
const EUR_ROW = '8f2a6c21-0c51-4c2e-9f3a-11d0b9b6f001';

/** The worker's cache, one snapshot per code: IRR 1,050,000 and EUR 0.92 per USD. */
const RATES: Record<string, { snapshotId: string; rate: string }> = {
  IRR: { snapshotId: IRR_ROW, rate: '1050000.00000000' },
  EUR: { snapshotId: EUR_ROW, rate: '0.92000000' },
};

/** A reseller's own live IRR pin (F-116-j): only a read naming `t-1` may see it. */
const TENANT_PIN = { id: 'pin-t1', rate: d('1200000'), effectiveAt: new Date('2026-09-28T09:00:00Z'), reason: 'r', expiresAt: new Date('2099-01-01T00:00:00Z') };

function fxReader() {
  const redis = {
    get: async (key: string) => {
      const code = key.split(':').pop() as string;
      const hit = RATES[code];
      return hit ? JSON.stringify({ ...hit, currencyCode: code, effectiveAt: '2026-09-28T09:00:00.000Z' }) : null;
    },
  };
  const prisma = {
    currency: { findUnique: async ({ where }: { where: { code: string } }) => ({ id: where.code }) },
    currencyExchangeRate: {
      findFirst: async ({ where }: { where: { currencyId: string; source?: string; OR?: { tenantId: string | null }[] } }) =>
        where.source === 'manual_admin' && where.currencyId === 'IRR' && where.OR?.some((o) => o.tenantId === 't-1')
          ? TENANT_PIN
          : null,
    },
  };
  return new FxRateReader(prisma as never, redis as never);
}

function gateway(overrides: Partial<SelectedGateway> = {}): SelectedGateway {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    isActive: true,
    displayName: 'Gateway',
    providerName: 'zarinpal',
    gatewayCategory: 'domestic_rial',
    minAcceptAmount: null,
    maxAcceptAmount: null,
    feeCalculationMode: 'manual',
    feeType: 'fixed',
    feeValue: d('0'),
    feeFloor: null,
    feeCeiling: null,
    useLiveRate: true,
    staticRate: null,
    percentageModifier: d('0'),
    fixedAmountModifier: d('0'),
    minRate: null,
    maxRate: null,
    roundingStep: null,
    roundingMode: 'up',
    taxRatePercent: null,
    depositPresets: [],
    callbackUrl: null,
    currencyCode: 'EUR',
    ...overrides,
  } as SelectedGateway;
}

function deps(chargeCurrency: string, chargeDecimals: number) {
  const provider = { name: 'zarinpal', chargeCurrency, chargeDecimals };
  return {
    providers: { get: () => provider, has: () => true } as never,
    merchant: { requireConfigured: async () => undefined } as never,
    fx: fxReader(),
  };
}

const input = (g: SelectedGateway, currencyCode: string, amount = '100.00') => ({
  gateway: g,
  ref: {} as never,
  amount: d(amount),
  discount: d('0'),
  defaultTaxRatePercent: null,
  actorId: 'u',
  currencyCode,
  ratesTenantId: null as string | null,
});

describe('F-116-e — a deposit is priced from the payer currency to the charge currency', () => {
  it('prices a EUR payer on a rial gateway at rate(IRR)/rate(EUR), and records both legs', async () => {
    const { price } = await priceDeposit(deps('IRR', 0), input(gateway(), 'EUR'));

    // 1,050,000 / 0.92 = 1,141,304.3478... rial per euro; 100 EUR, rounded up.
    expect(price.rate?.toFixed(6)).toBe('1141304.347826');
    expect(price.chargedAmountMinor).toBe(BigInt(114130435));
    expect(price.rateSnapshotId).toBe(IRR_ROW);
    expect(price.rateFromSnapshotId).toBe(EUR_ROW);
  });

  it('prices a reseller\'s user at its own IRR pin, and a billing top-up (no tenant) never (F-116-j)', async () => {
    const own = await priceDeposit(deps('IRR', 0), { ...input(gateway({ currencyCode: 'USD' }), 'USD'), ratesTenantId: 't-1' });
    const boundary = await priceDeposit(deps('IRR', 0), input(gateway({ currencyCode: 'USD' }), 'USD'));

    expect(own.price.rate?.toFixed()).toBe('1200000');
    expect(own.price.rateSnapshotId).toBe('pin-t1');
    expect(boundary.price.rate?.toFixed()).toBe('1050000');
    expect(boundary.price.rateSnapshotId).toBe(IRR_ROW);
  });

  it('a USD payer records the IRR leg only — USD is the pivot, no row backs it', async () => {
    const { price } = await priceDeposit(deps('IRR', 0), input(gateway({ currencyCode: 'USD' }), 'USD'));
    expect(price.rate?.toFixed()).toBe('1050000');
    expect(price.rateSnapshotId).toBe(IRR_ROW);
    expect(price.rateFromSnapshotId).toBeNull();
  });

  it('a gateway charging the payer currency itself prices at exactly 1, with no rate read', async () => {
    const { price } = await priceDeposit(deps('EUR', 2), input(gateway(), 'EUR'));
    expect(price.rate?.toFixed()).toBe('1');
    expect(price.chargedAmountMinor).toBe(BigInt(10000));
    expect([price.rateSnapshotId, price.rateFromSnapshotId]).toEqual([null, null]);
  });

  it('an inverse pair keeps its digits: the rate stored is the rate charged, at 18 places', async () => {
    const { price } = await priceDeposit(
      deps('USD', 2),
      input(gateway({ currencyCode: 'IRR' }), 'IRR', '2000000.00'),
    );
    // 1 / 1,050,000 = 0.000000952380952380952... -> 18 places, half-up.
    expect(price.rate?.toFixed()).toBe('0.000000952380952381');
    // $1.9047..., rounded up — and the stored rate reproduces it exactly, which
    // is what settlement divides by (`creditForReceipt`).
    expect(price.chargedAmountMinor).toBe(BigInt(191));
    const again = price.payable.mul(price.rate as Prisma.Decimal).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_CEIL);
    expect(BigInt(again.toFixed(0))).toBe(price.chargedAmountMinor);
    expect(price.rateSnapshotId).toBeNull();
    expect(price.rateFromSnapshotId).toBe(IRR_ROW);
  });

  it('a static-rate gateway converts at its own column and records no leg', async () => {
    const { price } = await priceDeposit(
      deps('IRR', 0),
      input(gateway({ useLiveRate: false, staticRate: d('1200000') }), 'EUR'),
    );
    expect(price.rate?.toFixed()).toBe('1200000');
    expect([price.rateSnapshotId, price.rateFromSnapshotId]).toEqual([null, null]);
  });

  it('a gateway configured in another currency than the payer is not offered, and cannot be priced', async () => {
    const lent = gateway({ currencyCode: 'TRY' });
    expect(offeredInCurrency(lent, 'EUR')).toBe(false);
    expect(offeredInCurrency(lent, 'TRY')).toBe(true);
    await expect(priceDeposit(deps('IRR', 0), input(lent, 'EUR'))).rejects.toThrow(InvalidPricingInput);
  });
});

describe('F-116-j — the currencies a tenant\'s gateways charge in', () => {
  it('names each known provider\'s charge currency once, sorted, and skips an unknown provider', () => {
    const charge: Record<string, string> = { zarinpal: 'IRR', stripe: 'USD', bale: 'IRR' };
    const providers = {
      has: (name: string) => name in charge,
      get: (name: string) => ({ chargeCurrency: charge[name] }),
    };
    const gateways = ['zarinpal', 'stripe', 'bale', 'gone'].map((providerName) => ({ providerName }));

    expect(chargeCurrenciesOf(gateways as never, providers as never)).toEqual(['IRR', 'USD']);
  });
});
