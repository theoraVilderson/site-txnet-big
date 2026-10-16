import { Prisma } from '@prisma/client';
import { OutboxEventType, operatingCurrencyOf } from '@txnet-backend/shared-core';

import { Day, addDays, dayOf } from './analytics-days';
import { analyticsStaffOf } from './analytics-staff';

/**
 * "This user costs more than they pay" (F-1003, contract.analytics-tabs.md
 * "Loss alert"): a user whose cost over the last 30 tenant days exceeds their
 * net by more than the tenant's percent (ADR-0149 (4)), told once per tenant
 * month to the tenant's staff — each holder of `analytics.read` and its owner —
 * on their bot and in their panel inbox (worker-service's person notice).
 */

/** Reported past this percent until a tenant sets its own (ADR-0149 (4)). */
export const LOSS_ALERT_DEFAULT_PERCENT = 20;
/** The widest threshold a tenant may set: cost six times its net. */
export const LOSS_ALERT_MAX_PERCENT = 500;
/** A user with no name is named by this much of their id — an id, never words of ours. */
const SHORT_ID = 8;
/** The days a user's cost and net are summed over, ending today. */
export const LOSS_WINDOW_DAYS = 30;

export type UserFigures = { userId: string; currencyCode: string; net: Prisma.Decimal; cost: Prisma.Decimal };

/** The users whose cost passed net × (1 + percent/100), in the operating currency only; one who cost nothing never is. */
export function usersOverThreshold(rows: readonly UserFigures[], how: { percent: number; operating: string }): UserFigures[] {
  const factor = new Prisma.Decimal(100 + how.percent).div(100);
  return rows.filter((r) => r.currencyCode === how.operating && r.cost.gt(0) && r.cost.gt(r.net.mul(factor)));
}

/** The first day of the tenant month `day` is in: the claim's key, so a user is told once a month. */
export const monthOf = (day: Day): Day => `${day.slice(0, 7)}-01`;

/** A claimed user, as told: who, their figures, the threshold they passed. */
export type LossClaim = { tenantId: string; userId: string; name: string; net: Prisma.Decimal; cost: Prisma.Decimal; currencyCode: string; percent: number };

/** One outbox payload per recipient (`userId` is the person told; `lossUserId` the one who costs). Strings throughout: notice params. */
export function lossNoticesOf(claim: LossClaim, recipients: readonly string[]) {
  return recipients.map((userId) => ({
    tenantId: claim.tenantId,
    userId,
    lossUserId: claim.userId,
    name: claim.name,
    net: claim.net.toFixed(2),
    cost: claim.cost.toFixed(2),
    currencyCode: claim.currencyCode,
    percent: String(claim.percent),
  }));
}

/** Each user's net and own cost over the window, per currency — cost in the operating currency where a rate converted it. */
function readUserFigures(tx: Prisma.TransactionClient, from: Day, to: Day): Promise<UserFigures[]> {
  return tx.$queryRaw<UserFigures[]>`
    WITH n AS (
      SELECT u."userId", u."currencyCode", SUM(u."net") AS "net" FROM billing.analytics_user_day u
      WHERE u."tenantId" = public.current_tenant_id() AND u."day" BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1, 2
    ), k AS (
      SELECT k."userId", k."saleCurrencyCode" AS "currencyCode", SUM(k."saleCost") AS "cost" FROM billing.analytics_cost_day k
      WHERE k."tenantId" = public.current_tenant_id() AND k."day" BETWEEN ${from}::date AND ${to}::date
        AND k."userId" IS NOT NULL AND k."saleCost" IS NOT NULL
        AND (k."servedTenantId" IS NULL OR k."servedTenantId" = public.current_tenant_id())
      GROUP BY 1, 2
    )
    SELECT k."userId"::text AS "userId", k."currencyCode", COALESCE(n."net", 0) AS "net", k."cost"
    FROM k LEFT JOIN n ON n."userId" = k."userId" AND n."currencyCode" = k."currencyCode"`;
}

/**
 * One tenant's pass, in its scope: every user over its threshold not yet
 * claimed this tenant month is claimed (`analytics_loss_alert`, the month
 * the key) and told to each of its staff. A claim already standing writes
 * nothing, so a second run the same month tells no one. Returns how many
 * users were newly told about.
 */
export async function tellLosses(tx: Prisma.TransactionClient, tenantId: string, now: Date = new Date()): Promise<number> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, ownerUserId: true } });
  const today = dayOf(now, tenant.timezone);
  const setting = await tx.analyticsSetting.findFirst({ select: { lossAlertPercent: true } });
  const percent = setting?.lossAlertPercent ?? LOSS_ALERT_DEFAULT_PERCENT;
  const operating = await operatingCurrencyOf(tx, tenantId);
  const over = usersOverThreshold(await readUserFigures(tx, addDays(today, 1 - LOSS_WINDOW_DAYS), today), { percent, operating });
  if (over.length === 0) return 0;

  const month = monthOf(today);
  const claimed = await tx.$queryRaw<{ userId: string }[]>`
    INSERT INTO billing.analytics_loss_alert ("tenantId", "userId", "month", "net", "cost", "currencyCode")
    SELECT public.current_tenant_id(), x."userId", ${month}::date, x."net", x."cost", ${operating}
    FROM unnest(${over.map((u) => u.userId)}::text[]::uuid[], ${over.map((u) => u.net.toFixed(2))}::numeric[], ${over.map((u) => u.cost.toFixed(2))}::numeric[]) AS x("userId", "net", "cost")
    ON CONFLICT DO NOTHING
    RETURNING "userId"::text AS "userId"`;
  if (claimed.length === 0) return 0;

  const recipients = await analyticsStaffOf(tx, { id: tenantId, ownerUserId: tenant.ownerUserId });
  const ids = claimed.map((c) => c.userId);
  const people = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, username: true } });
  const nameOf = new Map(people.map((p) => [p.id, p.fullName ?? p.username ?? null]));
  for (const user of over.filter((u) => ids.includes(u.userId))) {
    const claim = { tenantId, userId: user.userId, name: nameOf.get(user.userId) ?? `#${user.userId.slice(0, SHORT_ID)}`, net: user.net, cost: user.cost, currencyCode: operating, percent };
    for (const payload of lossNoticesOf(claim, recipients)) {
      await tx.outboxEvent.create({ data: { aggregate: 'billing.analytics', aggregateId: user.userId, type: OutboxEventType.ANALYTICS_USER_LOSS, payload }, select: { id: true } });
    }
  }
  return claimed.length;
}
