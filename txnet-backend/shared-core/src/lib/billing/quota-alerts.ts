import { Prisma } from '@prisma/client';

import { OutboxEventType } from '../automation/routing-keys';
import { isResellerLimitKey, type QuotaOverageTerms } from '../tenant/reseller-limits';
import { DEFAULT_QUOTA_TIME_ZONE, isTimeZone, quotaPeriodAt, type QuotaPeriod } from './quota-period';

/**
 * A reseller is told about its quotas (F-019-v8, ADR-0107 point 11). Who is
 * told is the reseller's owner, in the panel inbox and on the bot, by the
 * worker's notice consumer; the buyer a quota refuses hears only "not
 * available now" (F-019-v11).
 *
 * - **80% and 100%, at the act** ({@link alertQuotaCrossings}): the act whose
 *   included units cross 80%, or fill a window — or the first one sold past it
 *   — writes a `reseller_quota_alert` row and a `tenant.quota.alert` outbox
 *   event in its own transaction. 100% says what happens next: overage from
 *   the billing wallet at the price, or stopped.
 * - **Stopped, after a refusal** ({@link recordQuotaRefusal}): a refused act
 *   rolls its transaction back, so the engine reports it to a sink each
 *   service registers (`setQuotaRefusalSink`), which writes on a connection
 *   of its own: the day's refused units, and the alert — 100% for a `stop`
 *   (once, whether the filling act told it already or not), `stopped` with
 *   why for an overage nobody could pay (empty wallet, the spend cap).
 * - **The daily digest** ({@link quotaDigests}): yesterday's refused units and
 *   overage units and cost, per reseller, from 09:00 on the quota clock
 *   (user, 2026-10-01), once a day; nothing on a day with neither.
 *
 * **Once.** Every alert is a row keyed (tenant, meter, window, period start,
 * level); a duplicate is skipped and tells nothing.
 */

type Tx = Prisma.TransactionClient;

/** What an alert says; a window with no limit never alerts. */
export type QuotaAlertLevel = '80' | '100' | 'stopped' | 'digest';

/** One window as the act saw it: its period, what it includes, and its included units used before the act. */
export type QuotaWindowUse = { period: QuotaPeriod; included: number | null; used: number };

/** A refused act, as the engine reports it. */
export type QuotaRefusal = {
  tenantId: string;
  meter: string;
  qty: number;
  stoppedBy: 'stop' | 'wallet_empty' | 'spend_cap' | 'price_unavailable';
  included: number;
  /** The tightest window: the one the alert is told for. */
  window: QuotaPeriod;
  overage: QuotaOverageTerms;
  zone: string;
  at: Date;
};

/** The outbox aggregate of a reseller's quotas. */
export const TENANT_QUOTA_AGGREGATE = 'tenant.quota';

const THRESHOLD = 0.8;
const DIGEST_HOUR = 9;
const HOUR_MS = 3_600_000;
const SETTINGS_ID = 1;
const PRODUCT_METER = 'product:';

/** At the act, in its transaction, after its usage row: each window that crossed 80% or filled is told once. */
export async function alertQuotaCrossings(
  tx: Tx,
  input: { tenantId: string; meter: string; windows: readonly QuotaWindowUse[]; includedQty: number; overageQty: number; overage: QuotaOverageTerms },
): Promise<void> {
  for (const w of input.windows) {
    if (w.included === null) continue;
    const after = w.used + input.includedQty;
    const filled = after >= w.included && (w.used < w.included || input.overageQty > 0);
    const near = Math.ceil(w.included * THRESHOLD);
    const level: QuotaAlertLevel | null = filled ? '100' : w.included > 0 && w.used < near && after >= near ? '80' : null;
    if (level) await tell(tx, { tenantId: input.tenantId, meter: input.meter, period: w.period, level, included: w.included, overage: input.overage });
  }
}

/**
 * A refused act, on `db` — a connection of its own, since the act's
 * transaction rolled back. Adds its units to the day's refused total, then
 * tells the stop once a period.
 */
export async function recordQuotaRefusal(db: { $transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> }, r: QuotaRefusal): Promise<void> {
  const dayStart = quotaPeriodAt('day', r.at, r.zone).start;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "tenant"."reseller_quota_refusal" ("tenantId", "meter", "dayStart", "acts", "units", "lastStoppedBy", "updatedAt")
      VALUES (${r.tenantId}::uuid, ${r.meter}, ${dayStart}, 1, ${r.qty}, ${r.stoppedBy}, now())
      ON CONFLICT ("tenantId", "meter", "dayStart") DO UPDATE
      SET "acts" = "reseller_quota_refusal"."acts" + 1,
          "units" = "reseller_quota_refusal"."units" + EXCLUDED."units",
          "lastStoppedBy" = EXCLUDED."lastStoppedBy",
          "updatedAt" = now()`;
    const level: QuotaAlertLevel = r.stoppedBy === 'stop' ? '100' : 'stopped';
    await tell(tx, { tenantId: r.tenantId, meter: r.meter, period: r.window, level, included: r.included, overage: r.overage, stoppedBy: r.stoppedBy });
  });
}

/** What the digest found. `told`: the resellers newly told; a second run the same day tells none. */
export type QuotaDigestRun = { resellers: number; told: number };

type DigestDb = Tx & { $transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

/**
 * Yesterday on the quota clock, told to each reseller with refused units or
 * overage, from 09:00 today. Safe to run every hour: before 09:00 it reads
 * nothing, after it each reseller is told once (its `digest` row).
 */
export async function quotaDigests(db: DigestDb, now = new Date()): Promise<QuotaDigestRun> {
  const setting = await db.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: { quotaTimeZone: true } });
  const zone = setting && isTimeZone(setting.quotaTimeZone) ? setting.quotaTimeZone : DEFAULT_QUOTA_TIME_ZONE;
  const today = quotaPeriodAt('day', now, zone);
  if (now.getTime() - today.start.getTime() < DIGEST_HOUR * HOUR_MS) return { resellers: 0, told: 0 };
  const day = quotaPeriodAt('day', new Date(today.start.getTime() - 1), zone);

  const [refused, sold] = await Promise.all([
    db.resellerQuotaRefusal.groupBy({ by: ['tenantId'], where: { dayStart: day.start }, _sum: { units: true } }),
    db.resellerQuotaUsage.groupBy({
      by: ['tenantId', 'currencyCode'],
      where: { releasedAt: null, overageQty: { gt: 0 }, createdAt: { gte: day.start, lt: day.end } },
      _sum: { overageQty: true, overageAmount: true },
    }),
  ]);
  const byTenant = new Map<string, { refused: number; overageUnits: number; cost: string[] }>();
  const of = (id: string) => byTenant.get(id) ?? (byTenant.set(id, { refused: 0, overageUnits: 0, cost: [] }), byTenant.get(id)!);
  for (const r of refused) of(r.tenantId).refused += r._sum.units ?? 0;
  for (const s of sold) {
    const t = of(s.tenantId);
    t.overageUnits += s._sum.overageQty ?? 0;
    if (s.currencyCode && s._sum.overageAmount) t.cost.push(`${s._sum.overageAmount.toFixed(2)} ${s.currencyCode}`);
  }
  if (byTenant.size === 0) return { resellers: 0, told: 0 };

  const owners = await db.tenant.findMany({
    where: { id: { in: [...byTenant.keys()] }, tenantType: 'reseller', deletedAt: null },
    select: { id: true, ownerUserId: true },
  });
  let told = 0;
  for (const owner of owners) {
    const t = byTenant.get(owner.id)!;
    const wrote = await db.$transaction(async (tx) => {
      if (!(await claim(tx, { tenantId: owner.id, meter: '*', period: day, level: 'digest' }))) return false;
      await tx.outboxEvent.create({
        data: {
          aggregate: TENANT_QUOTA_AGGREGATE,
          aggregateId: owner.id,
          type: OutboxEventType.TENANT_QUOTA_DIGEST,
          payload: {
            tenantId: owner.id,
            ownerUserId: owner.ownerUserId,
            day: day.start.toISOString(),
            refused: String(t.refused),
            overageUnits: String(t.overageUnits),
            overageCost: t.cost.join(', ') || '0',
          },
        },
        select: { id: true },
      });
      return true;
    });
    if (wrote) told++;
  }
  return { resellers: owners.length, told };
}

/** The alert's row, then its event — nothing when the row was already there. */
async function tell(
  tx: Tx,
  a: { tenantId: string; meter: string; period: QuotaPeriod; level: QuotaAlertLevel; included: number; overage: QuotaOverageTerms; stoppedBy?: QuotaRefusal['stoppedBy'] },
): Promise<void> {
  if (!(await claim(tx, a))) return;
  const tenant = await tx.tenant.findUnique({ where: { id: a.tenantId }, select: { ownerUserId: true } });
  if (!tenant) return;
  const payload: Record<string, string> = {
    tenantId: a.tenantId,
    ownerUserId: tenant.ownerUserId,
    meter: a.meter,
    level: a.level,
    period: a.period.kind,
    included: String(a.included),
    mode: a.overage.mode,
    ...(a.stoppedBy ? { stoppedBy: a.stoppedBy } : {}),
    ...(a.overage.mode === 'overage' && a.overage.unitPrice ? { unitPrice: a.overage.unitPrice.toFixed(2), currencyCode: a.overage.currencyCode ?? '' } : {}),
    ...(await nameOf(tx, a.meter)),
  };
  await tx.outboxEvent.create({
    data: { aggregate: TENANT_QUOTA_AGGREGATE, aggregateId: a.tenantId, type: OutboxEventType.TENANT_QUOTA_ALERT, payload },
    select: { id: true },
  });
}

/** Writes the alert's row; false when it was already told. */
async function claim(tx: Tx, a: { tenantId: string; meter: string; period: QuotaPeriod; level: QuotaAlertLevel }): Promise<boolean> {
  const { count } = await tx.resellerQuotaAlert.createMany({
    data: [{ tenantId: a.tenantId, meter: a.meter, period: a.period.kind, periodStart: a.period.start, level: a.level }],
    skipDuplicates: true,
  });
  return count === 1;
}

/** How the owner's language names the quota: a registry key, or a product's catalog name key. */
async function nameOf(tx: Tx, meter: string): Promise<Record<string, string>> {
  if (isResellerLimitKey(meter)) return { quotaKey: meter };
  if (!meter.startsWith(PRODUCT_METER)) return {};
  const product = await tx.product.findFirst({ where: { id: meter.slice(PRODUCT_METER.length) }, select: { nameKey: true } });
  return product ? { productNameKey: product.nameKey } : {};
}
