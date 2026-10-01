import { TenantType, type Prisma } from '@prisma/client';

import {
  limitFromLevels,
  overageFromLevels,
  overageTermsOf,
  RESELLER_QUOTA_KEYS,
  resellerLimitOf,
  resellerOverageOf,
  type QuotaOverageTerms,
  type ResellerLimitSource,
  type ResellerQuotaKey,
} from '../tenant/reseller-limits';

/**
 * Quota terms locked per subscription period (ADR-0107 point 8, F-019-v3).
 * A reseller pays for a period; what its package sold it — the included
 * number, `stop` or `overage`, the unit price — holds until that period ends.
 *
 * - **Frozen just before the first change.** Every platform write that can
 *   change a quota key's terms (any level, or the reseller's package) first
 *   calls `lockQuotaTerms` for the resellers it reaches, in its transaction.
 *   Each one without a row for its current period gets the terms in force
 *   now. A second change finds the row and freezes nothing.
 * - **The kinder part wins** (user 2026-10-01). Read with the live terms, each
 *   part on its own: the larger number (no limit the largest), overage over
 *   `stop`, the lower price. A gift reaches the reseller at once; a cut waits
 *   for the next period.
 * - **The period is the paid one**, a year for a yearly plan (user
 *   2026-10-01): a row is keyed by the subscription's `currentPeriodEnd`, so
 *   the renewal that moves it ends the lock without touching a row. A
 *   reseller with no subscription has no period and is never locked.
 */

export type LockableSource = Exclude<ResellerLimitSource, 'exempt'>;

/** A quota key's terms for one reseller, each part with the level it came from. */
export type QuotaTermsInEffect = {
  included: number | null;
  includedSource: LockableSource;
  overage: QuotaOverageTerms;
  overageSource: LockableSource;
};

/** Which resellers a write reaches: named ones, a package's subscribers, or every reseller (a platform-level change). */
export type QuotaLockScope = { tenantIds: string[] } | { packageId: string } | { everyReseller: true };

/** Locked against live, part by part; `null` (no lock) is the live terms. */
export function kinderQuotaTerms(locked: QuotaTermsInEffect | null, live: QuotaTermsInEffect): QuotaTermsInEffect {
  if (!locked) return live;
  const lockedMore = live.included !== null && (locked.included === null || locked.included > live.included);
  const l = locked.overage;
  const n = live.overage;
  // Prices in two currencies are not compared: the currency change converts both, so a mismatch is one not yet converted.
  const lockedCheaper = l.mode === 'overage' && (n.mode === 'stop' || (l.currencyCode === n.currencyCode && l.unitPrice.lt(n.unitPrice)));
  return {
    included: lockedMore ? locked.included : live.included,
    includedSource: lockedMore ? locked.includedSource : live.includedSource,
    overage: lockedCheaper ? l : n,
    overageSource: lockedCheaper ? locked.overageSource : live.overageSource,
  };
}

/**
 * One reseller's terms for one quota key as the engine applies them, and
 * until when a lock holds them (`lockedUntil` null: none this period).
 * `null`: not a reseller, exempt.
 */
export async function quotaTermsInEffectOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  key: ResellerQuotaKey,
): Promise<(QuotaTermsInEffect & { lockedUntil: Date | null }) | null> {
  const [limit, overage, sub] = await Promise.all([
    resellerLimitOf(tx, tenantId, key),
    resellerOverageOf(tx, tenantId, key),
    tx.tenantSubscription.findUnique({ where: { tenantId }, select: { currentPeriodEnd: true } }),
  ]);
  if (limit.source === 'exempt' || overage.source === 'exempt') return null;
  const live: QuotaTermsInEffect = { included: limit.limit, includedSource: limit.source, overage: overageTermsOf(overage), overageSource: overage.source };
  const row = sub
    ? await tx.resellerQuotaTermsLock.findUnique({ where: { tenantId_key_periodEnd: { tenantId, key, periodEnd: sub.currentPeriodEnd } } })
    : null;
  if (!row) return { ...live, lockedUntil: null };
  const locked: QuotaTermsInEffect = {
    included: row.included,
    includedSource: row.includedSource as LockableSource,
    overage: overageTermsOf(row),
    overageSource: row.overageSource as LockableSource,
  };
  return { ...kinderQuotaTerms(locked, live), lockedUntil: row.periodEnd };
}

/**
 * Freezes the terms in force now for every reseller in `scope` that has a
 * subscription and no lock for its current period. Call it in the write's
 * transaction, **before** the write. Answers how many rows it froze.
 */
export async function lockQuotaTerms(
  tx: Prisma.TransactionClient,
  scope: QuotaLockScope,
  keys: readonly ResellerQuotaKey[] = RESELLER_QUOTA_KEYS,
): Promise<number> {
  if (keys.length === 0) return 0;
  const subWhere = 'packageId' in scope ? { packageId: scope.packageId } : 'tenantIds' in scope ? { tenantId: { in: scope.tenantIds } } : {};
  const subs = await tx.tenantSubscription.findMany({ where: subWhere, select: { tenantId: true, packageId: true, currentPeriodEnd: true } });
  if (subs.length === 0) return 0;
  const resellers = new Set(
    (await tx.tenant.findMany({ where: { id: { in: subs.map((s) => s.tenantId) }, tenantType: TenantType.reseller, deletedAt: null }, select: { id: true } })).map((t) => t.id),
  );
  const reach = subs.filter((s) => resellers.has(s.tenantId));
  if (reach.length === 0) return 0;

  const tenantIds = { tenantId: { in: reach.map((s) => s.tenantId) } };
  const packageIds = { packageId: { in: [...new Set(reach.map((s) => s.packageId))] } };
  const keyIn = { key: { in: [...keys] as string[] } };
  const overage = { key: true, mode: true, unitPrice: true, currencyCode: true } as const;
  const [locked, ownLimit, pkgLimit, platformLimit, ownOverage, pkgOverage, platformOverage] = await Promise.all([
    tx.resellerQuotaTermsLock.findMany({ where: { ...tenantIds, ...keyIn }, select: { tenantId: true, key: true, periodEnd: true } }),
    tx.resellerLimit.findMany({ where: { ...tenantIds, ...keyIn }, select: { tenantId: true, key: true, value: true } }),
    tx.packageLimit.findMany({ where: { ...packageIds, ...keyIn }, select: { packageId: true, key: true, value: true } }),
    tx.resellerLimitSetting.findMany({ where: keyIn, select: { key: true, value: true } }),
    tx.resellerQuotaOverage.findMany({ where: { ...tenantIds, ...keyIn }, select: { tenantId: true, ...overage } }),
    tx.packageQuotaOverage.findMany({ where: { ...packageIds, ...keyIn }, select: { packageId: true, ...overage } }),
    tx.quotaOverageSetting.findMany({ where: keyIn, select: overage }),
  ]);
  const done = new Set(locked.map((r) => `${r.tenantId}|${r.key}|${r.periodEnd.getTime()}`));

  const data: Prisma.ResellerQuotaTermsLockCreateManyInput[] = [];
  for (const s of reach) {
    for (const key of keys) {
      if (done.has(`${s.tenantId}|${key}|${s.currentPeriodEnd.getTime()}`)) continue;
      const mine = <T extends { tenantId: string; key: string }>(rows: T[]) => rows.find((r) => r.tenantId === s.tenantId && r.key === key);
      const pkgs = <T extends { packageId: string; key: string }>(rows: T[]) => rows.find((r) => r.packageId === s.packageId && r.key === key);
      const limit = limitFromLevels(key, mine(ownLimit), pkgs(pkgLimit), platformLimit.find((r) => r.key === key));
      const over = overageFromLevels(key, mine(ownOverage), pkgs(pkgOverage), platformOverage.find((r) => r.key === key));
      data.push({
        tenantId: s.tenantId,
        key,
        periodEnd: s.currentPeriodEnd,
        included: limit.limit,
        includedSource: limit.source,
        mode: over.mode,
        unitPrice: over.unitPrice,
        currencyCode: over.currencyCode,
        overageSource: over.source,
      });
    }
  }
  if (data.length === 0) return 0;
  // skipDuplicates: two writes racing for one period freeze it once — both read the same terms in force.
  return (await tx.resellerQuotaTermsLock.createMany({ data, skipDuplicates: true })).count;
}
