import { GrantStatus, VariantBillingMode } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

/** The levels a prepaid Grant's period is told at (F-601-d, spec 9.5), highest first. */
export const USAGE_LEVELS = [95, 80, 50] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];

/** One event type per level, so notification's `(Grant, notice, period)` ledger lets each through once. */
export const USAGE_LEVEL_EVENT: Record<UsageLevel, OutboxEventType> = {
  50: OutboxEventType.GRANT_USAGE_50,
  80: OutboxEventType.GRANT_USAGE_80,
  95: OutboxEventType.GRANT_USAGE_95,
};

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

const MIB = BigInt(1024 ** 2);
const GIB = BigInt(1024 ** 3);

/** What is left, as the notice says it: whole GB from 10, one decimal under, whole MB (at least 1) under 1 GB. */
export function remainingLabel(bytes: bigint): string {
  if (bytes >= BigInt(10) * GIB) return `${bytes / GIB} GB`;
  if (bytes >= GIB) {
    const tenths = (bytes * BigInt(10)) / GIB;
    return `${tenths / BigInt(10)}.${tenths % BigInt(10)} GB`;
  }
  const mb = bytes / MIB;
  return `${mb > BigInt(0) ? mb : BigInt(1)} MB`;
}
