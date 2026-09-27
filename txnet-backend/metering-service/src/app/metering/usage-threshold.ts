import { GrantStatus, VariantBillingMode } from '@prisma/client';
import { USAGE_LEVELS, type UsageLevel } from '@txnet-backend/shared-core';

export type UsageThresholdGrant = {
  status: GrantStatus;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  usagePeriodFromBytes: bigint;
  /** As the charge left it. */
  consumedBytes: bigint;
};

/**
 * The level one charge of `chargedBytes` crossed, or `null` (F-601-d).
 *
 * The share is of the **period's** bag — `purchasedBytes - usagePeriodFromBytes`
 * — because a renewal keeps Quota and Used cumulative (entitlement invariant
 * 16): of the cumulative figures, a Grant renewed at 96 % would read 48 % and
 * be told "half used" a day later. A charge that jumps past two levels tells
 * the higher alone. Nothing once the bag is spent — that is the cutoff notice
 * (F-601-b) — and nothing for a Grant with no bag: unlimited, metered (its
 * wallet's notice is F-601-g), not `active`, or a period that opened in debt.
 */
export function usageThresholdCrossed(g: UsageThresholdGrant, chargedBytes: bigint): { level: UsageLevel; remainingBytes: bigint } | null {
  if (g.status !== GrantStatus.active || g.billingMode !== VariantBillingMode.prepaid || g.trafficUnlimited) return null;
  if (chargedBytes <= BigInt(0)) return null;
  const bag = g.purchasedBytes - g.usagePeriodFromBytes;
  if (bag <= BigInt(0) || g.consumedBytes >= g.purchasedBytes) return null;
  const after = (g.consumedBytes - g.usagePeriodFromBytes) * BigInt(100);
  const before = after - chargedBytes * BigInt(100);
  for (const level of USAGE_LEVELS) {
    const mark = BigInt(level) * bag;
    if (before < mark && after >= mark) return { level, remainingBytes: g.purchasedBytes - g.consumedBytes };
  }
  return null;
}
