import { Injectable } from '@nestjs/common';
import { Prisma, type AiActionType } from '@prisma/client';
import { resolveTimeZone, tenantTransaction, type QuietWindow } from '@txnet-backend/shared-core';

import { HOURS_OF_WEEK } from '../profile/active-hours';
import type { Reason } from '../profile/predictions';
import { AiReaderPrisma, PrismaService } from '../prisma/prisma.service';
import { CHECKOUT_HELP_DEADLINE_MS, CHECKOUT_HELP_WAIT_MS, SUGGEST_LEAD_DAYS, WIN_BACK_LEAD_DAYS, type CandidateGrant, type CheckoutAttempt, type DecisionPrediction, type OfferOption, type PlanOption, type SeasonWindow } from './candidates';
import type { WholesaleRate } from './margin';
import { OFFER_GIVEN } from './offer-guardrail';
import type { SubjectDecisionInputs } from './pipeline';

const DAY_MS = 86_400_000;
const READ_TIMEOUT_MS = 30_000;

/** The predictions a candidate is built from (`candidates.ts`). */
const DECISION_KINDS = ['renewal_probability', 'right_size', 'meter_exhaustion', 'wallet_need', 'win_back_window', 'usage_spike'] as const;
/** The two that say *when* — an account none of them puts inside the lead time has nothing to decide. */
const TIMING_KINDS = ['renewal_probability', 'meter_exhaustion'] as const;

/**
 * A plan's bag: the variant's quota on the metric its bag meter fills (§4.5).
 * One bag meter exists today; a second product kind names its own here.
 * `limit` 0 is unlimited — no bag to resize.
 */
const BAG_QUOTA_METRIC = 'traffic_bytes';


function bagOf(quotas: Prisma.JsonValue): bigint | null {
  const limit = (quotas as Record<string, { limit?: unknown }> | null)?.[BAG_QUOTA_METRIC]?.limit;
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? BigInt(limit) : null;
}

/**
 * The price in force per variant from rows newest first: the tenant's own
 * before the platform's (as F-038-d reads it; the margin report too, F-1528).
 */
export function pricesInForce(
  rows: ReadonlyArray<{ variantId: string; tenantId: string | null; amount: Prisma.Decimal; currencyCode: string }>,
): Map<string, { amount: Prisma.Decimal; currencyCode: string }> {
  const price = new Map<string, { amount: Prisma.Decimal; currencyCode: string; own: boolean }>();
  for (const r of rows) {
    const seen = price.get(r.variantId);
    const own = r.tenantId !== null;
    if (!seen || (own && !seen.own)) price.set(r.variantId, { amount: r.amount, currencyCode: r.currencyCode, own });
  }
  return new Map([...price].map(([id, { amount, currencyCode }]) => [id, { amount, currencyCode }]));
}

/**
 * What the decision pipeline reads per subject (F-038-e), in the caller's
 * tenant scope (`runWithTenant`). The engine's own tables — predictions,
 * profiles, actions — on the app pool; every other unit's through
 * `txnet_ai_reader` (invariant 7): Grants, their wholesale legs (F-038-p),
 * variants and prices under RLS, an offer's template coupon (F-038-f2), the
 * user's zone by its column grant, the quiet window through
 * `ai.reader_quiet_hours`. `tenant.tenant` (no RLS) on the app pool, as every
 * service reads it.
 */
@Injectable()
export class DecisionReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: AiReaderPrisma,
  ) {}

  /**
   * A page of users with a renewal or a run-out inside the lead time, a win-back window closing (F-038-n), a usage
   * spike not yet a day old (F-1516), or a
   * gateway payment left unfinished long enough to help with (F-038-m, through the reader), by id.
   */
  async subjectsDue(tenantId: string, now: Date, cursor: string | null, take: number): Promise<string[]> {
    const until = new Date(now.getTime() + SUGGEST_LEAD_DAYS * DAY_MS);
    const winBackUntil = new Date(now.getTime() + WIN_BACK_LEAD_DAYS * DAY_MS);
    const rows = await tenantTransaction(this.prisma, (tx) =>
      tx.aiPrediction.findMany({
        where: {
          tenantId,
          subjectKind: 'user',
          OR: [
            { kind: { in: [...TIMING_KINDS] }, predictedAt: { gt: now, lte: until } },
            { kind: 'win_back_window', predictedAt: { gt: now, lte: winBackUntil } },
            { kind: 'usage_spike', predictedAt: { gt: now } },
          ],
          ...(cursor ? { subjectId: { gt: cursor } } : {}),
        },
        select: { subjectId: true },
        distinct: ['subjectId'],
        orderBy: { subjectId: 'asc' },
        take,
      }),
    );
    const unfinished = await tenantTransaction(this.reader, (tx) =>
      tx.paymentTransaction.findMany({
        where: {
          status: { in: ['failed', 'expired'] },
          createdAt: { gt: new Date(now.getTime() - CHECKOUT_HELP_DEADLINE_MS), lte: new Date(now.getTime() - CHECKOUT_HELP_WAIT_MS) },
          ...(cursor ? { userId: { gt: cursor } } : {}),
        },
        select: { userId: true },
        distinct: ['userId'],
        orderBy: { userId: 'asc' },
        take,
      }),
    );
    // Two sorted pages merged: the first `take` ids of their union, so the cursor stays one id.
    return [...new Set([...rows.map((r) => r.subjectId), ...unfinished.map((p) => p.userId)])].sort().slice(0, take);
  }

  async inputsFor(tenantId: string, userIds: string[], now: Date): Promise<Map<string, SubjectDecisionInputs>> {
    const out = new Map<string, SubjectDecisionInputs>();
    if (userIds.length === 0) return out;
    const dayAgo = new Date(now.getTime() - DAY_MS);

    const own = await tenantTransaction(
      this.prisma,
      async (tx) => {
        // One after the other: an interactive transaction is one connection.
        const predictions = await tx.aiPrediction.findMany({
          where: { tenantId, subjectKind: 'user', subjectId: { in: userIds }, kind: { in: [...DECISION_KINDS] } },
          select: { id: true, subjectId: true, kind: true, value: true, currencyCode: true, predictedAt: true, confidence: true, reasons: true },
        });
        const profiles = await tx.aiAccountProfile.findMany({
          where: { tenantId, subjectKind: 'user', subjectId: { in: userIds } },
          select: { subjectId: true, activeHours: true },
        });
        const actions = await tx.aiAction.findMany({
          where: {
            tenantId,
            subjectKind: 'user',
            subjectId: { in: userIds },
            OR: [{ status: 'scheduled' }, { status: 'suppressed', createdAt: { gt: dayAgo } }],
          },
          select: { subjectId: true, status: true, actionType: true, suppressedBy: true, scheduledFor: true },
        });
        const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
        // F-038-f2: the tenant's discounts, and which of them each account was already given.
        const offers = await tx.aiOffer.findMany({
          where: { tenantId, actionType: 'retain_offer', isActive: true },
          select: { id: true, variantId: true, couponTemplateId: true, maxDiscountPercent: true, currencyCode: true },
        });
        const given = offers.length
          ? await tx.aiAction.findMany({
              where: { tenantId, subjectKind: 'user', subjectId: { in: userIds }, offerId: { not: null }, status: { in: [...OFFER_GIVEN] } },
              select: { subjectId: true, offerId: true },
              distinct: ['subjectId', 'offerId'],
            })
          : [];
        return { predictions, profiles, actions, offers, given, tenantZone: tenant?.timezone ?? null };
      },
      { timeout: READ_TIMEOUT_MS },
    );

    const grantIds = [...new Set(own.predictions.map((p) => (p.reasons as Reason[])[0]?.['grantId']).filter((g): g is string => typeof g === 'string'))];
    const theirs = await tenantTransaction(
      this.reader,
      async (tx) => {
        const grants = await tx.grant.findMany({
          where: { id: { in: grantIds }, userId: { in: userIds } },
          select: { id: true, userId: true, variantId: true, endsAt: true },
        });
        const currentIds = [...new Set(grants.map((g) => g.variantId).filter((v): v is string => v !== null))];
        const current = await tx.productVariant.findMany({ where: { id: { in: currentIds } }, select: { productId: true } });
        const variants = await tx.productVariant.findMany({
          where: {
            OR: [{ id: { in: currentIds } }, { productId: { in: [...new Set(current.map((v) => v.productId))] }, isActive: true, visibility: 'public' }],
          },
          select: { id: true, productId: true, billingMode: true, durationDays: true, quotas: true },
        });
        const prices = await tx.price.findMany({
          where: { variantId: { in: variants.map((v) => v.id) }, isActive: true, effectiveFrom: { lte: now } },
          select: { variantId: true, tenantId: true, amount: true, currencyCode: true },
          orderBy: { effectiveFrom: 'desc' },
        });
        const legs = await tx.grantWholesale.findMany({
          where: { grantId: { in: grants.map((g) => g.id) } },
          select: { grantId: true, meterKey: true, unitSize: true, unitPrice: true, currencyCode: true },
        });
        const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, timezone: true, timezoneSource: true } });
        const templateIds = own.offers.map((o) => o.couponTemplateId).filter((c): c is string => c !== null);
        const templates = templateIds.length
          ? await tx.coupon.findMany({
              where: { id: { in: templateIds }, tenantId, deletedAt: null },
              select: { id: true, discountType: true, discountValue: true, maxDiscountCap: true, currencyCode: true },
            })
          : [];
        // F-038-m: the gateway payments of the last two days — the unfinished ones to help with, and any success after them.
        const payments = await tx.paymentTransaction.findMany({
          where: { userId: { in: userIds }, status: { in: ['failed', 'expired', 'success'] }, createdAt: { gt: new Date(now.getTime() - CHECKOUT_HELP_DEADLINE_MS) } },
          select: { id: true, userId: true, status: true, createdAt: true, amountRequested: true, currencyCode: true },
        });
        const windows = await tx.$queryRaw<Array<{ userId: string; quietStart: number; quietEnd: number; timezone: string | null }>>`
          SELECT "userId", "quietStart", "quietEnd", "timezone" FROM ai.reader_quiet_hours
          WHERE "userId" = ANY(ARRAY[${Prisma.join(userIds)}]::uuid[])`;
        // F-038-r: the seasons' campaigns on these plans that end ahead and start within the lead time (and a day).
        const seasons = await tx.priceCampaign.findMany({
          where: {
            variantId: { in: variants.map((v) => v.id) },
            seasonId: { not: null },
            cancelledAt: null,
            endsAt: { gt: now },
            startsAt: { lt: new Date(now.getTime() + (SUGGEST_LEAD_DAYS + 1) * DAY_MS) },
          },
          select: { variantId: true, amount: true, currencyCode: true, startsAt: true, endsAt: true, season: { select: { id: true, name: true } } },
        });
        return { grants, variants, prices, legs, users, windows, templates, payments, seasons };
      },
      { timeout: READ_TIMEOUT_MS },
    );

    const price = pricesInForce(theirs.prices);
    const plans = new Map<string, PlanOption>(
      theirs.variants.map((v) => {
        const p = price.get(v.id);
        return [
          v.id,
          {
            variantId: v.id,
            productId: v.productId,
            billingMode: v.billingMode,
            durationDays: v.durationDays,
            size: bagOf(v.quotas),
            price: p ? { amount: p.amount, currencyCode: p.currencyCode } : null,
          },
        ];
      }),
    );

    // A template offer whose coupon is gone is no offer; the target is fixed at creation (F-038-f1).
    const offers: OfferOption[] = own.offers.flatMap((o) => {
      const t = o.couponTemplateId ? theirs.templates.find((c) => c.id === o.couponTemplateId) : null;
      if (o.couponTemplateId && !t) return [];
      return [{ id: o.id, variantId: o.variantId, maxDiscountPercent: o.maxDiscountPercent, currencyCode: o.currencyCode, template: t ? { discountType: t.discountType, discountValue: t.discountValue, maxDiscountCap: t.maxDiscountCap, currencyCode: t.currencyCode } : null }];
    });

    const seasons: SeasonWindow[] = theirs.seasons.flatMap((s) =>
      s.season ? [{ seasonId: s.season.id, name: s.season.name, variantId: s.variantId, amount: s.amount, currencyCode: s.currencyCode, startsAt: s.startsAt, endsAt: s.endsAt }] : [],
    );

    for (const id of userIds) {
      const predictions: DecisionPrediction[] = own.predictions
        .filter((p) => p.subjectId === id)
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          value: p.value === null ? null : p.value.toNumber(),
          // An amount stays a decimal string with its currency (C-02, F-038-k).
          amount: p.currencyCode && p.value !== null ? p.value.toFixed(2) : null,
          currencyCode: p.currencyCode,
          predictedAt: p.predictedAt,
          confidence: p.confidence.toNumber(),
          reasons: p.reasons as Reason[],
        }));
      const grants = new Map<string, CandidateGrant>(
        theirs.grants.filter((g) => g.userId === id).map((g) => [g.id, { id: g.id, variantId: g.variantId, endsAt: g.endsAt }]),
      );
      const wholesale = new Map<string, WholesaleRate>(theirs.legs.filter((l) => grants.has(l.grantId)).map(({ grantId, ...rate }) => [grantId, rate]));
      const paid = theirs.payments.filter((p) => p.userId === id && p.status === 'success').map((p) => p.createdAt.getTime());
      const checkouts: CheckoutAttempt[] = theirs.payments
        .filter((p) => p.userId === id && (p.status === 'failed' || p.status === 'expired'))
        .map((p) => ({ paymentId: p.id, status: p.status as CheckoutAttempt['status'], at: p.createdAt, amount: p.amountRequested.toFixed(2), currencyCode: p.currencyCode }));
      const window = theirs.windows.find((w) => w.userId === id);
      const user = theirs.users.find((u) => u.id === id);
      const quiet: QuietWindow | null = window
        ? {
            quietStart: window.quietStart,
            quietEnd: window.quietEnd,
            timezone: window.timezone ?? resolveTimeZone({ user, tenant: { timezone: own.tenantZone } }).zone,
          }
        : null;
      const mine = own.actions.filter((a) => a.subjectId === id);
      out.set(id, {
        candidates: { predictions, grants, plans, wholesale, checkouts, lastPaidAt: paid.length ? new Date(Math.max(...paid)) : null, offers, usedOfferIds: new Set(own.given.filter((g) => g.subjectId === id).map((g) => g.offerId as string)), seasons },
        activeHours: own.profiles.find((p) => p.subjectId === id)?.activeHours ?? new Array<number>(HOURS_OF_WEEK).fill(0),
        quiet,
        pendingSends: mine.filter((a) => a.status === 'scheduled' && a.scheduledFor).map((a) => a.scheduledFor as Date),
        stoppedToday: mine
          .filter((a) => a.status === 'suppressed')
          .map((a) => ({ actionType: a.actionType as AiActionType, suppressedBy: a.suppressedBy })),
      });
    }
    return out;
  }
}
