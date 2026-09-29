import { Prisma, VariantBillingMode, type RateCardAfterIncluded, type RateCardMode } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import { rateCardAt, vpnTrafficRateAt, type RateCardRow } from '../catalog/catalog-reads';

/** A `grant_meter` row as issue writes it, before its Grant and tenant are known. */
export type GrantMeterTerms = {
  meterKey: string;
  rateCardId: string;
  unitSize: bigint;
  unitPrice: Prisma.Decimal;
  currencyCode: string;
  mode: RateCardMode;
  includedQuantity: bigint;
  afterIncluded: RateCardAfterIncluded;
  consumed: bigint;
  billed: bigint;
  funded: bigint;
};

/**
 * The meters a Grant is sold with (F-118-e, ADR-0105 decision 4): per meter,
 * the card in effect at `startsAt` in the tenant's currency (`rateCardAt`),
 * locked with its counters at zero — ADR-0073 for every meter.
 *
 * Only a meter something serves is locked, because a meter whose use nothing
 * refuses cannot be sold (decision 7):
 *  - `vpn.traffic` on a **metered** variant, when it is the card the byte
 *    engine serves (`vpnTrafficRateAt`): the Grant's rate and money cursor
 *    from then on (F-118-l). With none, issue refuses `metered_rate_missing` first.
 *  - `vpn.traffic` on any other variant is not read at all: a package plan's
 *    path never looks at a card (decision 0).
 *  - Any other meter in effect is `unserved` until its door exists (F-118-h);
 *    issue refuses it as `meter_not_served`.
 */
export function grantMetersFromVariant(
  v: { billingMode: VariantBillingMode; rateCards: readonly RateCardRow[] },
  startsAt: Date,
  currencyCode: string,
): { meters: GrantMeterTerms[]; unserved: string | null } {
  const meters: GrantMeterTerms[] = [];
  const keys = [...new Set(v.rateCards.map((c) => c.meterKey))].sort();
  for (const meterKey of keys) {
    const card = rateCardAt(v.rateCards, startsAt, currencyCode, meterKey);
    if (!card) continue;
    if (meterKey !== METER_KEYS.vpnTraffic) return { meters: [], unserved: meterKey };
    if (v.billingMode !== VariantBillingMode.metered || !vpnTrafficRateAt(v.rateCards, startsAt, currencyCode)) continue;
    meters.push({
      meterKey,
      rateCardId: card.id,
      unitSize: card.unitSize,
      unitPrice: card.unitPrice,
      currencyCode: card.currencyCode,
      mode: card.mode,
      includedQuantity: card.includedQuantity,
      afterIncluded: card.afterIncluded,
      consumed: BigInt(0),
      billed: BigInt(0),
      funded: BigInt(0),
    });
  }
  return { meters, unserved: null };
}
