import { FeeCalcMode, FeeType, PaymentGateway, Prisma, RateRoundingMode } from '@prisma/client';

/**
 * What a deposit costs at one gateway (F-092-e; catalog F-0609..F-0612).
 *
 * One pure function, called alike by the quote the panel shows (F-092-o) and by
 * the payment intent that charges (F-092-i). The legacy app computed the price
 * twice and clamped a provider-quoted fee on one path only, so what the user saw
 * and what the gateway charged disagreed; there is nothing to disagree with when
 * there is one function.
 *
 * Pure: no I/O, no clock, no database, no float. Everything that needs one of
 * those is the caller's and arrives as an argument:
 *  - `quotedFee` — an automatic-fee gateway's quote, asked of the provider for
 *    `feeBasis(request)` and converted to base currency (F-092-f);
 *  - `liveRate` — the FX rate the staleness ladder still allows (F-0607). Pass
 *    `null` when it allows none; the gateway's `staticRate` is then used, and
 *    with no `staticRate` the gateway cannot price.
 *
 * The order, which is the order of F-092-o's quote:
 *  1. `amount` (what the user asked to credit) must lie in the gateway's
 *     `[minAcceptAmount, maxAcceptAmount]`;
 *  2. `discount` (every coupon together, F-092-g) comes off it;
 *  3. gap — a remainder above zero but under the gateway minimum is raised to
 *     the minimum, and the difference is credited too, so the user pays more
 *     and receives exactly that much more;
 *  4. fee — fixed, a percentage of the basis, or the provider's quote, then the
 *     floor and the ceiling, in every mode;
 *  5. payable = basis + fee; credited = amount + gap.
 * A remainder of zero is the free path: nothing is charged, so there is no fee
 * and no rate, and no quote is needed.
 *
 * There is no tax here. A top-up is a prepayment, not a sale: tax is charged
 * when the credit buys a service (ADR-0038).
 *
 * Money is rounded to the cent **up**, never down, and so is the rate at its
 * `roundingStep` unless the gateway says `nearest`. A rate outside
 * `[minRate, maxRate]` is refused rather than clamped: rejecting a sale costs
 * one sale, charging at a wrong rate costs an unbounded amount (F-0607).
 */
export type GatewayPricing = Pick<
  PaymentGateway,
  | 'minAcceptAmount'
  | 'maxAcceptAmount'
  | 'feeCalculationMode'
  | 'feeType'
  | 'feeValue'
  | 'feeFloor'
  | 'feeCeiling'
  | 'useLiveRate'
  | 'staticRate'
  | 'percentageModifier'
  | 'fixedAmountModifier'
  | 'minRate'
  | 'maxRate'
  | 'roundingStep'
  | 'roundingMode'
>;

export type PriceRequest = {
  /** A `payment_gateway` row, or a `tenant_gateway_config` row — the columns are the same. */
  pricing: GatewayPricing;
  /** Base currency (ADR-0019), > 0, at most 2 decimal places. */
  amount: Prisma.Decimal;
  /** Every coupon together, 0 <= discount <= amount, at most 2 decimal places. */
  discount: Prisma.Decimal;
  /** Required when `feeCalculationMode` is `automatic` and something is charged. Base currency. */
  quotedFee?: Prisma.Decimal | null;
  /** Base -> gateway-currency rate the caller may use; `null` when none. */
  liveRate?: Prisma.Decimal | null;
  /** Decimal places of the gateway currency's minor unit: Zarinpal's rial is 0, a USD card is 2. */
  chargeDecimals: number;
};

export type GatewayPrice = {
  amount: Prisma.Decimal;
  discount: Prisma.Decimal;
  gap: Prisma.Decimal;
  fee: Prisma.Decimal;
  payable: Prisma.Decimal;
  credited: Prisma.Decimal;
  /** Nothing is charged; the gateway is never called. */
  free: boolean;
  /** The effective rate charged at — `exchangeRateSnapshot`. `null` on the free path. */
  rate: Prisma.Decimal | null;
  /** `payable` in the gateway currency's minor unit, rounded up. `null` on the free path. */
  chargedAmountMinor: bigint | null;
};

/** Refused input or a broken gateway config. A caller bug, never a user's mistake. */
export class InvalidPricingInput extends Error {
  constructor(reason: string) {
    super(`gateway pricing: ${reason}`);
    this.name = 'InvalidPricingInput';
  }
}

/** The requested amount is outside what this gateway accepts. */
export class AmountOutOfGatewayRange extends Error {
  constructor(
    readonly min: Prisma.Decimal,
    readonly max: Prisma.Decimal,
  ) {
    super(`amount must be between ${min.toFixed(MONEY_SCALE)} and ${max.toFixed(MONEY_SCALE)}`);
    this.name = 'AmountOutOfGatewayRange';
  }
}

/** An automatic-fee gateway was priced without the provider's quote. */
export class FeeQuoteRequired extends Error {
  constructor() {
    super('this gateway quotes its own fee; ask the provider for feeBasis() first');
    this.name = 'FeeQuoteRequired';
  }
}

/** No usable live rate and no `staticRate`: the gateway is disabled (F-0607). */
export class RateUnavailable extends Error {
  constructor() {
    super('no live rate and no static rate for this gateway');
    this.name = 'RateUnavailable';
  }
}

/** The effective rate falls outside the gateway's `[minRate, maxRate]`. */
export class RateOutOfRange extends Error {
  constructor(readonly rate: Prisma.Decimal) {
    super(`rate ${rate.toFixed()} is outside this gateway's accepted range`);
    this.name = 'RateOutOfRange';
  }
}

/** `payment_transaction` money columns are `Decimal(18, 2)`. */
const MONEY_SCALE = 2;

/**
 * A private constructor with room for every digit: an 18-digit amount times an
 * 18-digit rate exceeds the 20 significant digits decimal.js keeps by default,
 * and it would round there silently.
 */
const Dec = Prisma.Decimal.clone({ precision: 64 });
type Dec = Prisma.Decimal;

const ZERO = new Dec(0);

const dec = (v: Prisma.Decimal): Dec => new Dec(v.toString());
const decOrNull = (v: Prisma.Decimal | null | undefined): Dec | null => (v == null ? null : dec(v));
const out = (v: Dec, scale?: number): Prisma.Decimal =>
  new Prisma.Decimal(scale === undefined ? v.toFixed() : v.toFixed(scale));
const centsUp = (v: Dec): Dec => v.toDecimalPlaces(MONEY_SCALE, Dec.ROUND_UP);

function money(v: Prisma.Decimal, name: string): Dec {
  const d = dec(v);
  if (d.decimalPlaces() > MONEY_SCALE) {
    throw new InvalidPricingInput(`${name} has more than ${MONEY_SCALE} decimal places`);
  }
  return d;
}

type Settled = { amount: Dec; discount: Dec; gap: Dec; basis: Dec };

function checkConfig(p: GatewayPricing): void {
  if (dec(p.minAcceptAmount).gt(dec(p.maxAcceptAmount))) {
    throw new InvalidPricingInput('minAcceptAmount is above maxAcceptAmount');
  }
  if (dec(p.feeValue).lt(0)) throw new InvalidPricingInput('feeValue is negative');
  if (p.feeFloor != null && p.feeCeiling != null && dec(p.feeFloor).gt(dec(p.feeCeiling))) {
    throw new InvalidPricingInput('feeFloor is above feeCeiling');
  }
  if (p.roundingStep != null && dec(p.roundingStep).lte(0)) {
    throw new InvalidPricingInput('roundingStep must be positive');
  }
  if (p.roundingMode !== RateRoundingMode.up && p.roundingMode !== RateRoundingMode.nearest) {
    throw new InvalidPricingInput(`roundingMode must be up or nearest, got ${String(p.roundingMode)}`);
  }
}

/** Steps 1-3: the range check, the discount and the gap. */
function settle(request: PriceRequest): Settled {
  const { pricing } = request;
  checkConfig(pricing);

  const amount = money(request.amount, 'amount');
  const discount = money(request.discount, 'discount');
  if (amount.lte(0)) throw new InvalidPricingInput('amount must be positive');
  if (discount.lt(0)) throw new InvalidPricingInput('discount is negative');
  if (discount.gt(amount)) throw new InvalidPricingInput('discount is larger than the amount');

  const min = dec(pricing.minAcceptAmount);
  if (amount.lt(min) || amount.gt(dec(pricing.maxAcceptAmount))) {
    throw new AmountOutOfGatewayRange(pricing.minAcceptAmount, pricing.maxAcceptAmount);
  }

  const remainder = amount.minus(discount);
  const gap = remainder.gt(0) && remainder.lt(min) ? min.minus(remainder) : ZERO;
  return { amount, discount, gap, basis: remainder.plus(gap) };
}

function feeOf(p: GatewayPricing, basis: Dec, quotedFee: Prisma.Decimal | null | undefined): Dec {
  let fee: Dec;
  if (p.feeCalculationMode === FeeCalcMode.manual) {
    if (p.feeType === FeeType.fixed) fee = dec(p.feeValue);
    else if (p.feeType === FeeType.percentage) fee = basis.mul(dec(p.feeValue)).div(100);
    else throw new InvalidPricingInput(`unknown feeType ${String(p.feeType)}`);
  } else if (p.feeCalculationMode === FeeCalcMode.automatic) {
    if (quotedFee == null) throw new FeeQuoteRequired();
    fee = dec(quotedFee);
    if (fee.lt(0)) throw new InvalidPricingInput('quotedFee is negative');
  } else {
    throw new InvalidPricingInput(`unknown feeCalculationMode ${String(p.feeCalculationMode)}`);
  }

  fee = centsUp(fee);
  const floor = decOrNull(p.feeFloor);
  const ceiling = decOrNull(p.feeCeiling);
  if (floor && fee.lt(floor)) fee = floor;
  if (ceiling && fee.gt(ceiling)) fee = ceiling;
  return fee;
}

function rateOf(p: GatewayPricing, liveRate: Prisma.Decimal | null | undefined): Dec {
  const usable = (v: Prisma.Decimal | null | undefined): Dec | null => {
    const d = decOrNull(v);
    return d && d.gt(0) ? d : null;
  };
  const source = (p.useLiveRate ? usable(liveRate) : null) ?? usable(p.staticRate);
  if (!source) throw new RateUnavailable();

  let rate = source.mul(dec(p.percentageModifier).div(100).plus(1)).plus(dec(p.fixedAmountModifier));
  if (p.roundingStep != null) {
    const step = dec(p.roundingStep);
    const mode = p.roundingMode === RateRoundingMode.up ? Dec.ROUND_CEIL : Dec.ROUND_HALF_UP;
    rate = rate.div(step).toDecimalPlaces(0, mode).mul(step);
  }

  const min = decOrNull(p.minRate);
  const max = decOrNull(p.maxRate);
  if (rate.lte(0) || (min && rate.lt(min)) || (max && rate.gt(max))) {
    throw new RateOutOfRange(out(rate));
  }
  return rate;
}

/**
 * The amount a provider's fee quote must be asked for: the amount after the
 * discount and the gap. Zero means the free path — ask for nothing.
 */
export function feeBasis(request: PriceRequest): Prisma.Decimal {
  return out(settle(request).basis, MONEY_SCALE);
}

export function priceAtGateway(request: PriceRequest): GatewayPrice {
  const { chargeDecimals, pricing } = request;
  if (!Number.isInteger(chargeDecimals) || chargeDecimals < 0) {
    throw new InvalidPricingInput('chargeDecimals must be a non-negative integer');
  }

  const { amount, discount, gap, basis } = settle(request);
  const credited = amount.plus(gap);

  if (basis.isZero()) {
    return {
      amount: out(amount, MONEY_SCALE),
      discount: out(discount, MONEY_SCALE),
      gap: out(ZERO, MONEY_SCALE),
      fee: out(ZERO, MONEY_SCALE),
      payable: out(ZERO, MONEY_SCALE),
      credited: out(credited, MONEY_SCALE),
      free: true,
      rate: null,
      chargedAmountMinor: null,
    };
  }

  const fee = feeOf(pricing, basis, request.quotedFee);
  const payable = basis.plus(fee);
  const rate = rateOf(pricing, request.liveRate);
  const charged = payable
    .mul(rate)
    .mul(new Dec(10).pow(chargeDecimals))
    .toDecimalPlaces(0, Dec.ROUND_CEIL);

  return {
    amount: out(amount, MONEY_SCALE),
    discount: out(discount, MONEY_SCALE),
    gap: out(gap, MONEY_SCALE),
    fee: out(fee, MONEY_SCALE),
    payable: out(payable, MONEY_SCALE),
    credited: out(credited, MONEY_SCALE),
    free: false,
    rate: out(rate),
    chargedAmountMinor: BigInt(charged.toFixed(0)),
  };
}
