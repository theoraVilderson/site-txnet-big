import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';

import {
  feeBasis,
  feeQuoteAmountMinor,
  GatewayPricing,
  InvalidPricingInput,
  priceAtGateway,
  PriceRequest,
} from './gateway-pricing';

/**
 * The gateway pricing calculator (F-092-e, F-092-q; catalog F-0609..F-0611).
 *
 * The cases live in `gateway-pricing.golden.json`, hand-computed and written as
 * strings, so a change to the arithmetic shows up as a changed expected value
 * in review rather than as a quietly regenerated snapshot. The invariant this
 * file holds is F-0612's: the quote a user is shown and the amount the gateway
 * charges come out of this one function, so every rule that decides money —
 * the fee floor and ceiling in both modes, the gap, the rounding direction, the
 * refused rate — is pinned here and nowhere else.
 *
 * Since F-0606-b the live rate arrives with the snapshot it was read from, and
 * every case says which snapshot priced it — `SNAPSHOT_ID` where the FX
 * worker's rate was used, `null` where the gateway's `staticRate` was, or where
 * nothing was charged at all.
 */
type Golden = {
  configs: Record<string, Record<string, unknown>>;
  cases: Array<{
    name: string;
    config: string;
    override?: Record<string, unknown>;
    input: {
      amount: string;
      discount: string;
      quotedFee?: string | null;
      liveRate: string | null;
      chargeDecimals: number;
    };
    expect?: {
      gap: string;
      fee: string;
      payable: string;
      credited: string;
      free: boolean;
      rate: string | null;
      rateSnapshotId: string | null;
      chargedAmountMinor: string | null;
    };
    error?: string;
  }>;
};

const golden = JSON.parse(
  readFileSync(join(__dirname, 'gateway-pricing.golden.json'), 'utf8'),
) as Golden;

const DECIMAL_COLUMNS = [
  'minAcceptAmount',
  'maxAcceptAmount',
  'feeValue',
  'feeFloor',
  'feeCeiling',
  'staticRate',
  'percentageModifier',
  'fixedAmountModifier',
  'minRate',
  'maxRate',
  'roundingStep',
];

const dec = (v: string | null | undefined) => (v == null ? null : new Prisma.Decimal(v));

/** The `currency_exchange_rate` row the golden cases' live rate comes from. */
const SNAPSHOT_ID = 'a7c0f3e2-5b6d-4a19-9f28-3c1d8e4b70aa';

function pricingOf(raw: Record<string, unknown>): GatewayPricing {
  const row: Record<string, unknown> = { ...raw };
  for (const column of DECIMAL_COLUMNS) row[column] = dec(raw[column] as string | null);
  return row as GatewayPricing;
}

function requestOf(c: Golden['cases'][number]): PriceRequest {
  return {
    pricing: pricingOf({ ...golden.configs[c.config], ...c.override }),
    amount: new Prisma.Decimal(c.input.amount),
    discount: new Prisma.Decimal(c.input.discount),
    quotedFee: dec(c.input.quotedFee),
    liveRate: c.input.liveRate == null ? null : { snapshotId: SNAPSHOT_ID, rate: new Prisma.Decimal(c.input.liveRate) },
    chargeDecimals: c.input.chargeDecimals,
  };
}

describe('priceAtGateway — golden cases', () => {
  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const request = requestOf(c);

    if (c.error) {
      expect(() => priceAtGateway(request)).toThrow(expect.objectContaining({ name: c.error }));
      return;
    }

    const price = priceAtGateway(request);
    const e = c.expect!;
    expect({
      amount: price.amount.toFixed(2),
      discount: price.discount.toFixed(2),
      gap: price.gap.toFixed(2),
      fee: price.fee.toFixed(2),
      payable: price.payable.toFixed(2),
      credited: price.credited.toFixed(2),
      free: price.free,
      rate: price.rate?.toFixed() ?? null,
      rateSnapshotId: price.rateSnapshotId,
      chargedAmountMinor: price.chargedAmountMinor?.toString() ?? null,
    }).toEqual({
      ...e,
      amount: request.amount.toFixed(2),
      discount: request.discount.toFixed(2),
    });
  });
});

describe('feeBasis', () => {
  it('is the amount a provider quote must be asked for — after the discount and the gap', () => {
    const c = golden.cases.find((x) => x.name.startsWith('coupon interaction: a payable under'))!;
    expect(feeBasis(requestOf(c)).toFixed(2)).toBe('1.00');
  });
});

describe('the rate snapshot (F-0606-b)', () => {
  const liveCase = golden.cases.find((c) => c.expect?.rateSnapshotId != null)!;

  it('records the snapshot the live rate was read from, not the marked-up rate', () => {
    const price = priceAtGateway(requestOf(liveCase));
    // The gateway's modifiers and rounding move the rate; the id still names
    // the one `currency_exchange_rate` row it was derived from (ADR-0019).
    expect(price.rateSnapshotId).toBe(SNAPSHOT_ID);
    expect(price.rate?.toFixed()).not.toBe(liveCase.input.liveRate);
  });

  it('refuses a live rate that arrives without its snapshot id', () => {
    const request = requestOf(liveCase);
    request.liveRate = { snapshotId: '  ', rate: new Prisma.Decimal(liveCase.input.liveRate!) };
    // A rate no snapshot backs is the one state the rial path must never be in,
    // so it is a caller bug rather than a quiet fall back to `staticRate`.
    expect(() => priceAtGateway(request)).toThrow(InvalidPricingInput);
  });

  it('is null when the gateway priced from its own staticRate', () => {
    const staticCase = golden.cases.find((c) => c.name.startsWith('useLiveRate false ignores'))!;
    const price = priceAtGateway(requestOf(staticCase));
    expect(price.rate).not.toBeNull();
    expect(price.rateSnapshotId).toBeNull();
  });
});

describe('a gateway charging in the base currency (F-104-g)', () => {
  // Stripe charges USD, which is the base currency (ADR-0019). The live rate is
  // rial per dollar, so applying it — the default for every gateway — would
  // charge a 10 USD top-up as roughly 600,000 USD. The user's call, 2026-09-16:
  // such a gateway prices at exactly 1, whatever its rate columns say.
  const liveCase = golden.cases.find((c) => c.expect?.rateSnapshotId != null)!;

  it('charges at rate 1, ignoring the live rate, the static rate, modifiers, bounds and rounding', () => {
    const request = requestOf(liveCase);
    const usd: PriceRequest = { ...request, chargeDecimals: 2, chargesInBaseCurrency: true };
    usd.pricing = { ...usd.pricing, staticRate: new Prisma.Decimal('58000'), percentageModifier: new Prisma.Decimal('3'), minRate: new Prisma.Decimal('50000') };

    const price = priceAtGateway(usd);

    expect(price.rate?.toFixed()).toBe('1');
    expect(price.rateSnapshotId).toBeNull();
    expect(price.chargedAmountMinor).toBe(BigInt(price.payable.mul(100).toFixed(0)));
    expect(feeQuoteAmountMinor(usd)).toBe(BigInt(feeBasis(usd).mul(100).toFixed(0)));
  });
});

describe('purity (F-0610)', () => {
  it('reads no clock, no environment and no float', () => {
    const source = readFileSync(join(__dirname, 'gateway-pricing.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const forbidden of [/\bMath\./, /\bNumber\(/, /parseFloat|parseInt/, /\bDate\b/, /process\./, /\.toNumber\(/]) {
      expect(code).not.toMatch(forbidden);
    }
    expect(code.match(/from '([^']+)'/g)).toEqual(["from '@prisma/client'"]);
  });
});

describe('tax on a top-up (ADR-0076)', () => {
  // The USD card prices at 1 with a fixed 0.25 fee and a 5.00 minimum, so every
  // figure below is readable as it stands.
  const card = golden.configs['reseller-usd-card'];
  const taxed = (amount: string, gatewayRate: string | null, tenantRate: string | null, discount = '0.00'): PriceRequest => ({
    pricing: { ...pricingOf(card), taxRatePercent: dec(gatewayRate) },
    amount: new Prisma.Decimal(amount),
    discount: new Prisma.Decimal(discount),
    defaultTaxRatePercent: dec(tenantRate),
    chargeDecimals: 2,
  });
  const figures = (p: ReturnType<typeof priceAtGateway>) => ({
    fee: p.fee.toFixed(2),
    tax: p.tax.toFixed(2),
    taxRatePercent: p.taxRatePercent?.toFixed() ?? null,
    payable: p.payable.toFixed(2),
    credited: p.credited.toFixed(2),
    chargedAmountMinor: p.chargedAmountMinor?.toString() ?? null,
  });

  it("the gateway's rate wins over the tenant default, and tax is on the basis, not on the fee", () => {
    // 9% of 100.25 would be 9.02; tax is on what buys credit, 100.00.
    expect(figures(priceAtGateway(taxed('100.00', '9', '5')))).toEqual({
      fee: '0.25', tax: '9.00', taxRatePercent: '9', payable: '109.25', credited: '100.00', chargedAmountMinor: '10925',
    });
  });

  it('a gateway with no rate inherits the tenant default', () => {
    expect(figures(priceAtGateway(taxed('100.00', null, '5')))).toMatchObject({ tax: '5.00', taxRatePercent: '5', payable: '105.25' });
  });

  it('no rate at either level is no tax, and no rate recorded', () => {
    expect(figures(priceAtGateway(taxed('100.00', null, null)))).toMatchObject({ tax: '0.00', taxRatePercent: null, payable: '100.25' });
  });

  it('a gateway rate of zero is a rate, not inherit: it overrides a tenant default', () => {
    expect(figures(priceAtGateway(taxed('100.00', '0', '10')))).toMatchObject({ tax: '0.00', taxRatePercent: '0', payable: '100.25' });
  });

  it('rounds half-up to the cent, once — not up like the fee', () => {
    // 5% of 10.05 is 0.5025: the fee's centsUp would make it 0.51.
    expect(priceAtGateway(taxed('10.05', null, '5')).tax.toFixed(2)).toBe('0.50');
    // 5% of 10.10 is 0.505: exactly half goes up.
    expect(priceAtGateway(taxed('10.10', null, '5')).tax.toFixed(2)).toBe('0.51');
  });

  it('taxes what is paid for: after the coupon, with the gap, and leaves credited alone', () => {
    // 10 less an 8 coupon leaves 2, raised to the 5.00 minimum: 3 of gap, 13 credited.
    expect(figures(priceAtGateway(taxed('10.00', '10', null, '8.00')))).toEqual({
      fee: '0.25', tax: '0.50', taxRatePercent: '10', payable: '5.75', credited: '13.00', chargedAmountMinor: '575',
    });
  });

  it('the free path carries no tax and records no rate, whatever is configured', () => {
    expect(figures(priceAtGateway(taxed('10.00', '9', '5', '10.00')))).toEqual({
      fee: '0.00', tax: '0.00', taxRatePercent: null, payable: '0.00', credited: '10.00', chargedAmountMinor: null,
    });
  });

  it('a rate outside 0..100 at either level is a broken config', () => {
    expect(() => priceAtGateway(taxed('100.00', '100.5', null))).toThrow(InvalidPricingInput);
    expect(() => priceAtGateway(taxed('100.00', null, '-1'))).toThrow(InvalidPricingInput);
  });
});
