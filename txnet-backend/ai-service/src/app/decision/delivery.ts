import { Injectable } from '@nestjs/common';
import { Prisma, type AiAction } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { SafetyFloor } from '../floor/safety-floor';
import type { Reason } from '../profile/predictions';
import { PrismaService } from '../prisma/prisma.service';
import { labelledMessage } from './action-log';

/**
 * F-038-g2 (ADR-0109 points 10, 11): what worker-service delivers a scheduled
 * suggestion through (F-038-g3). The worker owns *when* (ADR-0027); this
 * service owns the action's state and the safety floor:
 *
 * 1. `take` — due `scheduled` actions, leased {@link DELIVERY_LEASE_MS} forward
 *    so a second take does not see them (`FOR UPDATE SKIP LOCKED`); one past
 *    its deadline is `expired` instead, never told late.
 * 2. notification's claim (F-038-g1), by the worker.
 * 3. `floor` — `SafetyFloor.check` as an engine message, the last check
 *    before it leaves; it charges the budget when it passes.
 * 4. `sent`, or `stop` with the claim's answer.
 *
 * A refusal that can wait — the budget or the platform silence reopening, a
 * retention notice 24 h old — moves `scheduledFor` when that is before the
 * deadline ({@link afterRefusal}); otherwise the action is `suppressed` with
 * the step. Every change is to a `scheduled` row only, in its own tenant.
 */

export const DELIVERY_LEASE_MS = 10 * 60_000;
/** An action with no deadline is moved at most this far. */
const NO_DEADLINE_HORIZON_MS = 7 * 24 * 3_600_000;

export function afterRefusal(deadline: Date | null, retryAt: Date | null, now: Date): { reschedule: Date } | { stop: true } {
  const limit = deadline?.getTime() ?? now.getTime() + NO_DEADLINE_HORIZON_MS;
  return retryAt && retryAt.getTime() <= limit ? { reschedule: retryAt } : { stop: true };
}

type DueRow = Pick<
  AiAction,
  'id' | 'tenantId' | 'subjectKind' | 'subjectId' | 'actionType' | 'status' | 'templateKey' | 'renderedBy' | 'renderedText' | 'deadline' | 'reasons'
>;

/**
 * The labelled message (F-1509) and what its template needs, read from the row's own `suggest_variant`
 * reason — and, for `top_up_wallet` (F-038-k), the amount to top up from its `suggest_top_up` (C-02: a
 * decimal string with its currency); for `retain_offer` (F-038-f2), its offer from `suggest_offer`.
 */
export function deliveryItem(row: DueRow) {
  const reasons = (row.reasons as Reason[] | null) ?? [];
  const target = reasons.find((r) => r.code === 'suggest_variant') ?? null;
  const topUp = reasons.find((r) => r.code === 'suggest_top_up') ?? null;
  const offer = reasons.find((r) => r.code === 'suggest_offer') ?? null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    ...labelledMessage(row),
    grantId: str(target?.['grantId']),
    variantId: str(target?.['variantId']),
    fromVariantId: str(target?.['fromVariantId']),
    price: target && str(target['price']) && str(target['currencyCode']) ? { amount: target['price'] as string, currencyCode: target['currencyCode'] as string } : null,
    amount: topUp && str(topUp['amount']) && str(topUp['currencyCode']) ? { amount: topUp['amount'] as string, currencyCode: topUp['currencyCode'] as string } : null,
    // F-038-f2: the offer billing issues the personal coupon from (F-038-f3), and the discount the engine priced.
    offer:
      offer && str(offer['offerId']) && str(offer['discountPercent']) && str(offer['discount']) && str(offer['currencyCode'])
        ? { offerId: offer['offerId'] as string, discountPercent: offer['discountPercent'] as string, discount: { amount: offer['discount'] as string, currencyCode: offer['currencyCode'] as string } }
        : null,
    deadline: row.deadline ? row.deadline.toISOString() : null,
  };
}

export type DeliveryItem = ReturnType<typeof deliveryItem>;

const SCHEDULED = 'scheduled' as const;

@Injectable()
export class ActionDelivery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly safety: SafetyFloor,
  ) {}

  /** Due suggestions of every tenant, oldest first, up to `limit`; leased. */
  async take(limit: number, now: Date): Promise<DeliveryItem[]> {
    // `tenant.tenant` has no RLS; the app pool lists it as the rebuild does.
    const tenants = await this.prisma.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    const out: DeliveryItem[] = [];
    const leaseTo = new Date(now.getTime() + DELIVERY_LEASE_MS);
    for (const { id } of tenants) {
      if (out.length >= limit) break;
      const rows = await runWithTenant({ id }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          await tx.aiAction.updateMany({
            where: { tenantId: id, status: SCHEDULED, deadline: { lt: now } },
            data: { status: 'expired', outcomeAt: now },
          });
          return tx.$queryRaw<DueRow[]>(Prisma.sql`
            UPDATE ai.action AS t SET "scheduledFor" = ${leaseTo}
            WHERE t."id" IN (
              SELECT a."id" FROM ai.action a
              WHERE a."tenantId" = ${id}::uuid AND a."status" = 'scheduled'::"ai"."AiActionStatus" AND a."scheduledFor" <= ${now}
              ORDER BY a."scheduledFor"
              LIMIT ${limit - out.length}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING t."id", t."tenantId", t."subjectKind", t."subjectId", t."actionType", t."status", t."templateKey",
                      t."renderedBy", t."renderedText", t."deadline", t."reasons"`);
        }),
      );
      out.push(...rows.map(deliveryItem));
    }
    return out;
  }

  /** The safety floor for one taken action. `null`: no such scheduled action in that tenant. */
  async floor(
    tenantId: string,
    actionId: string,
    now: Date,
  ): Promise<null | { pass: true } | { pass: false; suppressedBy: string; rescheduledTo?: string }> {
    const action = await this.scheduled(tenantId, actionId);
    if (!action) return null;
    const subject = { tenantId: action.tenantId, kind: action.subjectKind, id: action.subjectId };
    const verdict = await this.safety.check(tenantId, subject, 'engine', now);
    if (!('suppressedBy' in verdict)) return { pass: true };
    const next = await this.refuse(tenantId, actionId, action.deadline, verdict.suppressedBy, verdict.until, now);
    return { pass: false, suppressedBy: verdict.suppressedBy, ...next };
  }

  /** The claim said `muted` (no `retryAt`) or `later` (with one). */
  async stop(tenantId: string, actionId: string, by: string, retryAt: Date | null, now: Date): Promise<{ suppressedBy: string } | { rescheduledTo: string } | null> {
    const action = await this.scheduled(tenantId, actionId);
    if (!action) return null;
    const next = await this.refuse(tenantId, actionId, action.deadline, by, retryAt, now);
    return next.rescheduledTo ? { rescheduledTo: next.rescheduledTo } : { suppressedBy: by };
  }

  async sent(tenantId: string, actionId: string, now: Date): Promise<{ sent: boolean }> {
    const { count } = await this.write(tenantId, (tx) =>
      tx.aiAction.updateMany({ where: { id: actionId, tenantId, status: SCHEDULED }, data: { status: 'sent', sentAt: now } }),
    );
    return { sent: count === 1 };
  }

  private scheduled(tenantId: string, actionId: string) {
    return this.write(tenantId, (tx) =>
      tx.aiAction.findFirst({
        where: { id: actionId, tenantId, status: SCHEDULED },
        select: { id: true, tenantId: true, subjectKind: true, subjectId: true, deadline: true },
      }),
    );
  }

  private async refuse(tenantId: string, actionId: string, deadline: Date | null, by: string, retryAt: Date | null, now: Date): Promise<{ rescheduledTo?: string }> {
    const next = afterRefusal(deadline, retryAt, now);
    const where = { id: actionId, tenantId, status: SCHEDULED };
    if ('reschedule' in next) {
      await this.write(tenantId, (tx) => tx.aiAction.updateMany({ where, data: { scheduledFor: next.reschedule } }));
      return { rescheduledTo: next.reschedule.toISOString() };
    }
    await this.write(tenantId, (tx) => tx.aiAction.updateMany({ where, data: { status: 'suppressed', suppressedBy: by } }));
    return {};
  }

  private write<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runWithTenant({ id: tenantId }, () => tenantTransaction(this.prisma, fn));
  }
}
