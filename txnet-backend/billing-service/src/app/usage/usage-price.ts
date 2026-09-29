import { GrantMeter, Prisma } from '@prisma/client';

/**
 * The arithmetic of usage rating (F-118-g), shared by the settlement and the
 * prepaid refund: integer `bigint` over a price in 1e-8 per `unitSize`, whole
 * cents out (C-02). See `usage-settlement.ts` for the rules it serves.
 */

/** `unitPrice` is `Decimal(18, 8)`: computed as an integer number of 1e-8. */
const PRICE_SCALE = 8;
const PRICE_UNIT = BigInt(100_000_000);
/** One cent in 1e-8 — `wallet_transaction.amount` is `Decimal(18, 2)` (C-02). */
export const CENT = BigInt(1_000_000);
export const ZERO = BigInt(0);


export type UsageSettlementRefusal =
  | 'grant_not_found'
  | 'meter_not_on_grant'
  /** `vpn.traffic`: its bytes are priced by the block purchaser until F-118-k. */
  | 'meter_on_its_own_path'
  | 'grant_not_active'
  /** A prepaid call on a postpaid meter, or the other way round. */
  | 'wrong_mode'
  /** An `afterIncluded: stop` card: nothing past the included quantity is sold. */
  | 'not_metered_past_included'
  | 'target_not_positive'
  /** A zero price, or one finer than `Decimal(18, 8)`. A free unit is a catalog decision. */
  | 'rate_not_priceable'
  /** The free balance cannot fund one cent. The enforcer serves nothing more. */
  | 'insufficient_funds'
  /** A price so high that a whole cent buys less than one unit. */
  | 'block_below_one_unit'
  /** A settlement raced this one; nothing was written. */
  | 'cursor_moved';

export class UsageSettlementRefused extends Error {
  constructor(
    readonly reason: UsageSettlementRefusal,
    detail = '',
  ) {
    super(`usage settlement refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'UsageSettlementRefused';
  }
}

export type Priced = Pick<GrantMeter, 'unitSize' | 'unitPrice' | 'includedQuantity'>;

export const max = (a: bigint, b: bigint) => (a > b ? a : b);
export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;
export const toCents = (amount: Prisma.Decimal) => BigInt(amount.mul(100).floor().toFixed(0));
export const toAmount = (cents: bigint) => new Prisma.Decimal(cents.toString()).div(100);

/** The price of `unitSize` units, in 1e-8. */
export function priceUnits(meter: Priced): bigint {
  if (meter.unitPrice.lte(0) || meter.unitPrice.decimalPlaces() > PRICE_SCALE) {
    throw new UsageSettlementRefused('rate_not_priceable', meter.unitPrice.toString());
  }
  return BigInt(meter.unitPrice.mul(PRICE_UNIT.toString()).toFixed(0));
}

/** How many whole units `cents` pay for, rounded down. */
export function unitsCovered(meter: Priced, cents: bigint): bigint {
  return (cents * CENT * meter.unitSize) / priceUnits(meter);
}

/**
 * A capture over `(billed, consumed]`: the cents it charges, rounded **down**,
 * and where `billed` then stands — past the included part, and only as far as
 * those cents cover. `cents` 0 moves nothing. `limitCents` caps it at a hold.
 */
export function capturable(meter: Priced, billed: bigint, consumed: bigint, limitCents?: bigint): { cents: bigint; billedTo: bigint } {
  const from = max(billed, meter.includedQuantity);
  const due = consumed - from;
  if (due <= ZERO) return { cents: ZERO, billedTo: billed };
  let cents = (due * priceUnits(meter)) / (meter.unitSize * CENT);
  if (limitCents !== undefined) cents = min(cents, limitCents);
  if (cents <= ZERO) return { cents: ZERO, billedTo: billed };
  return { cents, billedTo: from + min(due, unitsCovered(meter, cents)) };
}

/**
 * A prepaid block: `target` units priced and rounded **up** to a cent, clamped
 * to the free balance, and the units those cents buy, rounded down — the
 * block covers the target and is never larger than what was paid.
 */
export function blockFor(meter: Priced, target: bigint, freeBalance: Prisma.Decimal): { cents: bigint; units: bigint } {
  if (target <= ZERO) throw new UsageSettlementRefused('target_not_positive', target.toString());
  const cents = min(ceilDiv(target * priceUnits(meter), meter.unitSize * CENT), toCents(freeBalance));
  if (cents < BigInt(1)) throw new UsageSettlementRefused('insufficient_funds', freeBalance.toString());
  const units = unitsCovered(meter, cents);
  if (units < BigInt(1)) throw new UsageSettlementRefused('block_below_one_unit', meter.unitPrice.toString());
  return { cents, units };
}

/**
 * `billed`/`funded` written only if neither moved since `read`. A settlement
 * that raced another is `cursor_moved`, with nothing written.
 */
export async function moveCursors(
  tx: Prisma.TransactionClient,
  read: Pick<GrantMeter, 'id' | 'billed' | 'funded'>,
  data: { billed?: bigint; funded?: bigint },
): Promise<void> {
  const { count } = await tx.grantMeter.updateMany({ where: { id: read.id, billed: read.billed, funded: read.funded }, data });
  if (count !== 1) throw new UsageSettlementRefused('cursor_moved', read.id);
}
