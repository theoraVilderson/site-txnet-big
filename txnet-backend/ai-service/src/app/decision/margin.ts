import { Prisma } from '@prisma/client';
import { METER_KEYS, moneyText } from '@txnet-backend/shared-core';

import type { Reason } from '../profile/predictions';

/**
 * F-038-p / ADR-0109 point 8: what a plan costs its seller, so the pipeline
 * ranks by margin, not revenue. A reseller's package plan is bought wholesale
 * (entitlement `contract.package-wholesale.md`): its Grant's `grant_wholesale`
 * row holds the rate it locked — per `unitSize` bytes for a bag
 * (`vpn.traffic`), per `unitSize` seconds for an unlimited plan
 * (`vpn.unlimited.time`). The plan suggested is priced at that rate, a
 * partial unit counted whole, as the reseller is charged.
 *
 * The cost is **unknown**, never guessed, when the Grant has no leg — the
 * platform's own sale, a reseller's own panels, a metered Grant — or when the
 * rate is in another currency than the price (C-02: never across two).
 */

const DAY_SECONDS = BigInt(86_400);

export type WholesaleRate = { meterKey: string; unitSize: bigint; unitPrice: Prisma.Decimal; currencyCode: string };

type Plan = { size: bigint | null; durationDays: number | null; price: { currencyCode: string } | null };

export function wholesaleCost(plan: Plan, rate: WholesaleRate | null): { cost: Prisma.Decimal | null; reason: Reason } {
  if (!rate) return { cost: null, reason: { code: 'cost_unknown', why: 'no_wholesale_leg' } };
  if (plan.price && rate.currencyCode !== plan.price.currencyCode) {
    return { cost: null, reason: { code: 'cost_unknown', why: 'other_currency', currencyCode: rate.currencyCode } };
  }
  const quantity =
    rate.meterKey === METER_KEYS.vpnTraffic ? plan.size : rate.meterKey === METER_KEYS.unlimitedTime && plan.durationDays ? BigInt(plan.durationDays) * DAY_SECONDS : null;
  if (quantity === null || rate.unitSize <= BigInt(0)) return { cost: null, reason: { code: 'cost_unknown', why: 'not_measured', meterKey: rate.meterKey } };
  const units = (quantity + rate.unitSize - BigInt(1)) / rate.unitSize;
  const cost = rate.unitPrice.times(units.toString());
  return {
    cost,
    reason: { code: 'wholesale_cost', meterKey: rate.meterKey, units: units.toString(), unitPrice: rate.unitPrice.toString(), cost: moneyText(cost), currencyCode: rate.currencyCode },
  };
}
