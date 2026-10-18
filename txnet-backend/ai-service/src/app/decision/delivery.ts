import { Injectable } from '@nestjs/common';
import { Prisma, type AiAction, type AiOffer } from '@prisma/client';
import { runWithTenant, tenantTransaction, moneyText, percentText } from '@txnet-backend/shared-core';

import { SafetyFloor } from '../floor/safety-floor';
import { ResellerReader } from '../profile/reseller-reader';
import type { Reason } from '../profile/predictions';
import { PrismaService } from '../prisma/prisma.service';
import { labelledMessage } from './action-log';
import { prizeStops } from './prize-hold';
import { PrizeReader } from './prize-reader';

/**
 * F-038-g2 (ADR-0109 points 10, 11): what worker-service delivers a scheduled
 * suggestion through (F-038-g3). The worker owns *when* (ADR-0027); this
 * service owns the action's state and the safety floor:
 *
 * 1. `take` — due `scheduled` actions, leased {@link DELIVERY_LEASE_MS} forward
 *    so a second take does not see them (`FOR UPDATE SKIP LOCKED`); one past
 *    its deadline is `expired` instead, never told late; one a prize won since
 *    its decision now holds is `suppressed` `prize` (F-038-y).
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
> & { offerId?: string | null };

/** What billing issues a `retain_offer`'s personal coupon from (F-038-f3): the offer as the tenant set it. */
type OfferTerms = Pick<AiOffer, 'id' | 'couponTemplateId' | 'maxDiscountPercent' | 'dailyBudget' | 'currencyCode' | 'createdByUserId'>;

/**
 * The labelled message (F-1509) and what its template needs, read from the row's own `suggest_variant`
 * reason — and, for `top_up_wallet` (F-038-k), the amount to top up from its `suggest_top_up` (C-02: a
 * decimal string with its currency); for `retain_offer` (F-038-f2), its offer from `suggest_offer`; for
 * `checkout_help` (F-038-m), the payment from `checkout_attempt`; for `usage_alert` (F-1516), its Grant and
 * numbers from `usage_spike` — bytes as decimal strings.
 */
/**
 * What a reseller's upgrade (F-038-o4) is told with, read at the take — never
 * the decision's: who owns the reseller now, its package now, and the named
 * package's name, status and price for the reseller's period today.
 */
export type ResellerLive = {
  recipientUserId: string;
  currentPackageId: string | null;
  packageName: string | null;
  packageActive: boolean;
  /** The package's price for the reseller's period now; null when it has none. */
  livePrice: string | null;
  /** A product's sales quota: the product's catalog name key. */
  productNameKey: string | null;
  /** F-1525-c: the reseller's billing wallet now, a decimal string; null with none. */
  walletBalance: string | null;
};

export function deliveryItem(row: DueRow, terms?: OfferTerms, live?: ResellerLive) {
  const reasons = (row.reasons as Reason[] | null) ?? [];
  const target = reasons.find((r) => r.code === 'suggest_variant') ?? null;
  const topUp = reasons.find((r) => r.code === 'suggest_top_up') ?? null;
  const offer = reasons.find((r) => r.code === 'suggest_offer') ?? null;
  const attempt = reasons.find((r) => r.code === 'checkout_attempt') ?? null;
  const spike = reasons.find((r) => r.code === 'usage_spike') ?? null;
  const upgrade = reasons.find((r) => r.code === 'suggest_package') ?? null;
  const wholesale = reasons.find((r) => r.code === 'wholesale_rate') ?? null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    ...labelledMessage(row),
    grantId: str(target?.['grantId']) ?? str(spike?.['grantId']),
    variantId: str(target?.['variantId']),
    fromVariantId: str(target?.['fromVariantId']),
    price: target && str(target['price']) && str(target['currencyCode']) ? { amount: target['price'] as string, currencyCode: target['currencyCode'] as string } : null,
    amount: topUp && str(topUp['amount']) && str(topUp['currencyCode']) ? { amount: topUp['amount'] as string, currencyCode: topUp['currencyCode'] as string } : null,
    // F-038-f2: the offer billing issues the personal coupon from (F-038-f3), and the discount the engine priced.
    offer:
      offer && str(offer['offerId']) && str(offer['discountPercent']) && str(offer['discount']) && str(offer['currencyCode'])
        ? {
            offerId: offer['offerId'] as string,
            discountPercent: offer['discountPercent'] as string,
            discount: { amount: offer['discount'] as string, currencyCode: offer['currencyCode'] as string },
            ...(terms && terms.id === offer['offerId']
              ? {
                  couponTemplateId: terms.couponTemplateId,
                  maxDiscountPercent: percentText(terms.maxDiscountPercent),
                  dailyBudget: moneyText(terms.dailyBudget),
                  budgetCurrencyCode: terms.currencyCode,
                  createdByUserId: terms.createdByUserId,
                }
              : {}),
          }
        : null,
    // F-038-m: the unfinished payment `checkout_help` is about — billing names another gateway for it.
    payment:
      attempt && str(attempt['paymentId']) && str(attempt['amount']) && str(attempt['currencyCode'])
        ? { paymentId: attempt['paymentId'] as string, amount: { amount: attempt['amount'] as string, currencyCode: attempt['currencyCode'] as string } }
        : null,
    // F-1516: what the last 24 h used against the usual day — the Grant's own meter, nothing else.
    usage:
      spike && str(spike['meterKey']) && str(spike['lastDayBytes']) && str(spike['usualDayBytes']) && typeof spike['factor'] === 'number'
        ? { meterKey: spike['meterKey'] as string, lastDayBytes: spike['lastDayBytes'] as string, usualDayBytes: spike['usualDayBytes'] as string, factor: spike['factor'] }
        : null,
    // F-038-o4 / F-1525-c: a reseller's suggestion — the upgrade's package and quota, or the top-up's balances.
    reseller:
      row.subjectKind === 'tenant' && live
        ? {
            recipientUserId: live.recipientUserId,
            currentPackageId: live.currentPackageId,
            fromPackageId: str(upgrade?.['fromPackageId']),
            packageId: str(upgrade?.['packageId']),
            packageName: upgrade ? live.packageName : null,
            packageActive: upgrade ? live.packageActive : false,
            price: upgrade && live.livePrice && str(upgrade['currencyCode']) ? { amount: live.livePrice, currencyCode: upgrade['currencyCode'] as string } : null,
            meter: str(upgrade?.['meter']),
            period: str(upgrade?.['period']),
            included: num(upgrade?.['included']),
            used: num(upgrade?.['used']),
            newIncluded: num(upgrade?.['newIncluded']),
            productNameKey: live.productNameKey,
            balanceThen: str(wholesale?.['balance']),
            balanceNow: live.walletBalance,
          }
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
    private readonly resellers: ResellerReader,
    private readonly prizes: PrizeReader,
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
          const due = await tx.$queryRaw<DueRow[]>(Prisma.sql`
            UPDATE ai.action AS t SET "scheduledFor" = ${leaseTo}
            WHERE t."id" IN (
              SELECT a."id" FROM ai.action a
              WHERE a."tenantId" = ${id}::uuid AND a."status" = 'scheduled'::"ai"."AiActionStatus" AND a."scheduledFor" <= ${now}
              ORDER BY a."scheduledFor"
              LIMIT ${limit - out.length}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING t."id", t."tenantId", t."subjectKind", t."subjectId", t."actionType", t."status", t."templateKey",
                      t."renderedBy", t."renderedText", t."deadline", t."reasons", t."offerId"`);
          // F-038-f3: billing issues a `retain_offer`'s coupon from its offer's terms, as the tenant set them.
          const offerIds = [...new Set(due.map((r) => r.offerId).filter((o): o is string => !!o))];
          const offers = offerIds.length
            ? await tx.aiOffer.findMany({
                where: { id: { in: offerIds }, tenantId: id },
                select: { id: true, couponTemplateId: true, maxDiscountPercent: true, dailyBudget: true, currencyCode: true, createdByUserId: true },
              })
            : [];
          return due.map((r) => ({ row: r, terms: offers.find((o) => o.id === r.offerId) }));
        }),
      );
      const stopped = await this.prizeHeld(id, rows.map((r) => r.row), now);
      const kept = rows.filter((r) => !stopped.has(r.row.id));
      const live = kept.some((r) => r.row.subjectKind === 'tenant') ? await this.resellersLive(id, kept.map((r) => r.row)) : new Map<string, ResellerLive>();
      out.push(...kept.map(({ row, terms }) => deliveryItem(row, terms, live.get(row.id))));
    }
    return out;
  }

  /** F-038-y: stops, as `prize`, the leased rows a prize won since their decision now holds; answers their ids. */
  private async prizeHeld(tenantId: string, rows: DueRow[], now: Date): Promise<Set<string>> {
    const users = [...new Set(rows.filter((r) => r.subjectKind === 'user').map((r) => r.subjectId))];
    if (users.length === 0) return new Set();
    const stops = prizeStops(rows, await this.prizes.holds(tenantId, users, now));
    if (stops.size > 0) {
      await this.write(tenantId, (tx) =>
        tx.aiAction.updateMany({ where: { id: { in: [...stops] }, tenantId, status: SCHEDULED }, data: { status: 'suppressed', suppressedBy: 'prize' } }),
      );
    }
    return stops;
  }

  /**
   * F-038-o4 / F-1525-c: what a reseller's suggestion is told with, read now through the
   * reader in the platform's scope (`ai.reader_reseller`, the packages).
   * A reseller gone from the list has no entry: the worker refuses the item.
   */
  private async resellersLive(platformTenantId: string, rows: DueRow[]): Promise<Map<string, ResellerLive>> {
    const [resellers, packages] = await Promise.all([this.resellers.resellers(platformTenantId), this.resellers.packages(platformTenantId)]);
    const byId = new Map(resellers.map((r) => [r.tenantId, r]));
    const named = (row: DueRow) => ((row.reasons as Reason[] | null) ?? []).find((r) => r.code === 'suggest_package');
    const products = rows.flatMap((row) => {
      const meter = named(row)?.['meter'];
      return typeof meter === 'string' && meter.startsWith('product:') ? [meter.slice('product:'.length)] : [];
    });
    const nameKeys = await this.resellers.productNameKeys(platformTenantId, [...new Set(products)]);
    const out = new Map<string, ResellerLive>();
    for (const row of rows) {
      const reseller = byId.get(row.subjectId);
      const reason = named(row);
      if (row.subjectKind !== 'tenant' || !reseller) continue;
      const pkg = reason ? packages.find((p) => p.id === reason['packageId']) : undefined;
      const price = !pkg ? null : reseller.billingModel === 'subscription_yearly' ? pkg.yearlyPrice : reseller.billingModel === 'subscription_monthly' ? pkg.monthlyPrice : null;
      const meter = typeof reason?.['meter'] === 'string' ? reason['meter'] : '';
      out.set(row.id, {
        recipientUserId: reseller.ownerUserId,
        currentPackageId: reseller.packageId,
        packageName: pkg?.name ?? null,
        packageActive: pkg?.isActive ?? false,
        livePrice: price && pkg?.currencyCode === reason?.['currencyCode'] ? moneyText(price) : null,
        productNameKey: meter.startsWith('product:') ? (nameKeys.get(meter.slice('product:'.length)) ?? null) : null,
        walletBalance: reseller.walletBalance ? moneyText(reseller.walletBalance) : null,
      });
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
