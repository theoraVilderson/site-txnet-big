import { Injectable } from '@nestjs/common';
import { Prisma, type AiActionType } from '@prisma/client';
import { resolveTimeZone, tenantTransaction, type QuietWindow } from '@txnet-backend/shared-core';

import { HOURS_OF_WEEK } from '../profile/active-hours';
import type { Reason } from '../profile/predictions';
import { AiReaderPrisma, PrismaService } from '../prisma/prisma.service';
import { SUGGEST_LEAD_DAYS, WIN_BACK_LEAD_DAYS, type CandidateGrant, type DecisionPrediction, type PlanOption } from './candidates';
import type { WholesaleRate } from './margin';
import type { SubjectDecisionInputs } from './pipeline';

const DAY_MS = 86_400_000;
const READ_TIMEOUT_MS = 30_000;

/** The predictions a candidate is built from (`candidates.ts`). */
const DECISION_KINDS = ['renewal_probability', 'right_size', 'meter_exhaustion', 'wallet_need', 'win_back_window'] as const;
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
 * What the decision pipeline reads per subject (F-038-e), in the caller's
 * tenant scope (`runWithTenant`). The engine's own tables — predictions,
 * profiles, actions — on the app pool; every other unit's through
 * `txnet_ai_reader` (invariant 7): Grants, their wholesale legs (F-038-p),
 * variants and prices under RLS, the
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

  /** A page of users with a renewal or a run-out inside the lead time, or a win-back window closing (F-038-n), by id. */
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
          ],
          ...(cursor ? { subjectId: { gt: cursor } } : {}),
        },
        select: { subjectId: true },
        distinct: ['subjectId'],
        orderBy: { subjectId: 'asc' },
        take,
      }),
    );
    return rows.map((r) => r.subjectId);
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
        return { predictions, profiles, actions, tenantZone: tenant?.timezone ?? null };
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
        const windows = await tx.$queryRaw<Array<{ userId: string; quietStart: number; quietEnd: number; timezone: string | null }>>`
          SELECT "userId", "quietStart", "quietEnd", "timezone" FROM ai.reader_quiet_hours
          WHERE "userId" = ANY(ARRAY[${Prisma.join(userIds)}]::uuid[])`;
        return { grants, variants, prices, legs, users, windows };
      },
      { timeout: READ_TIMEOUT_MS },
    );

    // The price in force: the tenant's own before the platform's (as F-038-d reads it).
    const price = new Map<string, { amount: Prisma.Decimal; currencyCode: string; own: boolean }>();
    for (const r of theirs.prices) {
      const seen = price.get(r.variantId);
      const own = r.tenantId !== null;
      if (!seen || (own && !seen.own)) price.set(r.variantId, { amount: r.amount, currencyCode: r.currencyCode, own });
    }
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
        candidates: { predictions, grants, plans, wholesale },
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
