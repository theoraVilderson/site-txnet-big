import { Injectable } from '@nestjs/common';
import { AiActionStatus, AiActionType, Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CANDIDATE_TYPES } from '../decision/candidates';
import { THRESHOLD_SUPPRESSION } from '../decision/confidence-threshold';
import { OFFER_ACTION_TYPES } from '../decision/offers';
import { AI_V1_ACTION_TYPES } from '../policy/ai-defaults';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 86_400_000;

/** How far back the settings page's per-type activity reaches (F-038-j3). */
export const ACTIVITY_WINDOW_DAYS = 30;

/** Statuses that mean the suggestion reached the customer. */
const DELIVERED: readonly AiActionStatus[] = [AiActionStatus.sent, AiActionStatus.accepted, AiActionStatus.dismissed];
/** Statuses still waiting to go out. */
const QUEUED: readonly AiActionStatus[] = [AiActionStatus.scheduled, AiActionStatus.awaiting_approval];

/**
 * Why a type cannot run whatever the settings say: `active_offer` — a
 * discount type with no active offer to give; `not_available` — the engine
 * has no candidate rule for it yet (`trial_convert` until F-038-l).
 */
export type TypeWaitsOn = 'active_offer' | 'not_available' | null;

export type TypeActivity = {
  type: AiActionType;
  sent: number;
  queued: number;
  heldByThreshold: number;
  /** Held for any other reason (cooldown, budget, holdout, another suggestion won…) or expired. */
  heldOtherwise: number;
  /** The confidences the engine gave this type in the window; null with no rows — never a guess. */
  confidence: { min: string; max: string } | null;
  waitsOn: TypeWaitsOn;
};

export type ActivityView = { windowDays: number; types: TypeActivity[] };

type GroupRow = {
  actionType: AiActionType;
  status: AiActionStatus;
  suppressedBy: string | null;
  _count: { _all: number };
  _min: { confidence: Prisma.Decimal | null };
  _max: { confidence: Prisma.Decimal | null };
};

function waitsOnOf(type: AiActionType, activeOfferTypes: readonly AiActionType[]): TypeWaitsOn {
  if (!(CANDIDATE_TYPES as readonly AiActionType[]).includes(type)) return 'not_available';
  const needsOffer = (OFFER_ACTION_TYPES as readonly AiActionType[]).includes(type);
  return needsOffer && !activeOfferTypes.includes(type) ? 'active_offer' : null;
}

const lower = (a: Prisma.Decimal, b: Prisma.Decimal | null) => (b && b.lessThan(a) ? b : a);
const higher = (a: Prisma.Decimal, b: Prisma.Decimal | null) => (b && b.greaterThan(a) ? b : a);

/** One type's counts and confidence range from its grouped rows. Pure. */
function activityOfType(type: AiActionType, rows: readonly GroupRow[], activeOfferTypes: readonly AiActionType[]): TypeActivity {
  const out: TypeActivity = { type, sent: 0, queued: 0, heldByThreshold: 0, heldOtherwise: 0, confidence: null, waitsOn: waitsOnOf(type, activeOfferTypes) };
  let min: Prisma.Decimal | null = null;
  let max: Prisma.Decimal | null = null;
  for (const r of rows.filter((x) => x.actionType === type)) {
    const n = r._count._all;
    if (DELIVERED.includes(r.status)) out.sent += n;
    else if (QUEUED.includes(r.status)) out.queued += n;
    else if (r.suppressedBy === THRESHOLD_SUPPRESSION) out.heldByThreshold += n;
    else out.heldOtherwise += n;
    if (r._min.confidence) min = min ? lower(min, r._min.confidence) : r._min.confidence;
    if (r._max.confidence) max = max ? higher(max, r._max.confidence) : r._max.confidence;
  }
  if (min && max) out.confidence = { min: min.toString(), max: max.toString() };
  return out;
}

/** Every switchable type's activity, in the settings' order (F-038-j3). Pure. */
export function activityOf(input: { types: readonly AiActionType[]; rows: readonly GroupRow[]; activeOfferTypes: readonly AiActionType[] }): TypeActivity[] {
  return input.types.map((type) => activityOfType(type, input.rows, input.activeOfferTypes));
}

/**
 * What each action type actually did over the last 30 days (F-038-j3), for
 * the AI settings page: read from the actions the engine recorded, so the
 * page never restates the engine's rules or confidences — a type the
 * threshold silences shows it in its numbers. The tenant's own, under RLS.
 */
@Injectable()
export class SettingsActivity {
  constructor(private readonly prisma: PrismaService) {}

  async read(tenantId: string, now: Date): Promise<ActivityView> {
    const since = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * DAY_MS);
    const { rows, offers } = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => ({
        rows: await tx.aiAction.groupBy({
          by: ['actionType', 'status', 'suppressedBy'],
          where: { tenantId, createdAt: { gte: since } },
          _count: { _all: true },
          _min: { confidence: true },
          _max: { confidence: true },
        }),
        offers: await tx.aiOffer.findMany({ where: { tenantId, isActive: true }, select: { actionType: true }, distinct: ['actionType'] }),
      })),
    );
    return {
      windowDays: ACTIVITY_WINDOW_DAYS,
      types: activityOf({ types: AI_V1_ACTION_TYPES, rows, activeOfferTypes: offers.map((o) => o.actionType) }),
    };
  }
}
