import { Prisma, type RateCardAfterIncluded, type RateCardMode } from '@prisma/client';

import { METER_KEYS } from './meter';
import { METERED_RATE_UNIT_BYTES, type MeteredRateRow } from './metered-rate';
import { effectiveIn } from './offers';

/** A row of a variant's rate card history (F-118-d, ADR-0105 decision 3), as anything that resolves one reads it. */
export type RateCardRow = {
  id: string;
  meterKey: string;
  unitSize: bigint;
  unitPrice: Prisma.Decimal;
  currencyCode: string;
  mode: RateCardMode;
  includedQuantity: bigint;
  afterIncluded: RateCardAfterIncluded;
  effectiveFrom: Date;
  isActive: boolean;
};

/** The cards {@link rateCardAt} chooses among at `at` in `currencyCode` — for one meter, or every meter when none is named (a Grant's issue, F-118-e) — asked of the database. */
export const rateCardsInEffect = (at: Date, currencyCode: string, meterKey?: string) =>
  ({ isActive: true, effectiveFrom: { lte: at }, currencyCode, ...(meterKey === undefined ? {} : { meterKey }) }) satisfies Prisma.RateCardWhereInput;

/**
 * The card in effect at `at` for `meterKey`: the newest active one in the
 * tenant's currency that had already taken effect — a price's rule (F-0602,
 * F-116-d), per meter. Read once, at the moment of sale; nothing prices usage
 * from the catalog afterwards (ADR-0073).
 */
export function rateCardAt<T extends RateCardRow>(cards: readonly T[], at: Date, currencyCode: string, meterKey: string): T | null {
  return effectiveIn(
    cards.filter((c) => c.meterKey === meterKey),
    at,
    currencyCode,
  );
}

/**
 * Whether the byte engine serves a `vpn.traffic` card of this shape: per 2^30
 * bytes, nothing included, then metered, in either mode. The one rule a sale
 * ({@link vpnTrafficRateAt}) and a write (F-118-m: a card nothing would sell
 * is refused, not stored) both ask.
 */
export function servedByBytes(card: Pick<RateCardRow, 'mode' | 'afterIncluded' | 'includedQuantity' | 'unitSize'>): boolean {
  return (
    (card.mode === 'prepaid' || card.mode === 'postpaid') &&
    card.afterIncluded === 'metered' &&
    card.includedQuantity === BigInt(0) &&
    card.unitSize === BigInt(METERED_RATE_UNIT_BYTES)
  );
}

/**
 * What a metered VPN Grant locks as its `vpn.traffic` meter at issue (ADR-0073, F-118-l): the
 * `vpn.traffic` card in effect, when it is one the byte engine serves — per
 * 2^30 bytes, nothing included, then metered; prepaid (every card
 * `metered_rate` became: blocks) or postpaid (F-118-k: a hold, captured).
 *
 * Any other newest card — a hybrid or a stop (`grant_meter`, F-118-e),
 * another unit size — is **no rate**, and the older card behind it is not
 * taken in its place: the seller's latest word was not that price. The Grant
 * is then refused as having no rate, never sold at the wrong one.
 */
export function vpnTrafficRateAt(cards: readonly RateCardRow[], at: Date, currencyCode: string): MeteredRateRow | null {
  const card = rateCardAt(cards, at, currencyCode, METER_KEYS.vpnTraffic);
  if (!card || !servedByBytes(card)) return null;
  return { id: card.id, rate: card.unitPrice, currencyCode: card.currencyCode, effectiveFrom: card.effectiveFrom, isActive: card.isActive };
}
