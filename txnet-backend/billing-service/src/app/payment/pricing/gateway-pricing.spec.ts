import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';

import {
  feeBasis,
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
