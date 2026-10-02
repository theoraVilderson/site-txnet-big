import { Prisma, type AiActionType, type AiPredictionKind, type VariantBillingMode } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';

import type { Reason } from '../profile/predictions';
import type { ActionCandidate } from './action-log';
import { wholesaleCost, type WholesaleRate } from './margin';

/**
 * F-038-e / ADR-0109 point 8, the first step: candidates by rules, from the
 * predictions the hourly rebuild stored (F-038-d). Pure — the reads are the
 * pipeline's.
 *
 * One candidate per Grant at most. A Grant whose size is wrong — too small
 * (`resize_up`) or too big (`resize_down`, F-1514) — is offered the right
 * size *instead of* the same plan again: a renewal and a resize of one
 * Grant are one decision, and sending both would be two messages about it.
 *
 * Nothing is suggested earlier than `SUGGEST_LEAD_DAYS` before it matters —
 * the Grant's end, or the day its bag is predicted to run out, whichever is
 * first. That moment is also the action's deadline.
 *
 * The engine never sets a price (point 9): a candidate names a plan the
 * tenant sells, at the price in force, and its expected margin is
 * P(renewal) × (price − cost): the seller's wholesale cost at its Grant's
 * locked rate (F-038-p, `margin.ts`). A cost not known is counted as nothing
 * and the reason says so; a negative margin is flagged `losingMoney`.
 */

const DAY_MS = 86_400_000;

export const SUGGEST_LEAD_DAYS = 7;

/**
 * F-1514: a smaller plan must hold the most they used in a period plus this
 * much — a plan cut to the byte runs out in the next busy month, and the
 * buyer blames the seller who suggested it.
 */
export const RESIZE_DOWN_HEADROOM = 1.25;

/** The types this file proposes. Each new action row adds its own. */
export const CANDIDATE_TYPES = ['renew', 'resize_up', 'resize_down'] as const satisfies readonly AiActionType[];
export type CandidateType = (typeof CANDIDATE_TYPES)[number];

/** C-07: a key chosen at runtime comes from an exhaustive Record. */
export const SUGGESTION_TEMPLATE_KEY: Record<CandidateType, string> = {
  renew: BackendI18nKeys.notifications.suggestion.renew,
  resize_up: BackendI18nKeys.notifications.suggestion.resize_up,
  resize_down: BackendI18nKeys.notifications.suggestion.resize_down,
};

export type DecisionPrediction = {
  id: string;
  kind: AiPredictionKind;
  value: number | null;
  predictedAt: Date | null;
  confidence: number;
  reasons: Reason[];
};

export type CandidateGrant = { id: string; variantId: string | null; endsAt: Date | null };

/** A plan the tenant sells: a variant, its bag (`size`, in its meter's unit) and its price in force. */
export type PlanOption = {
  variantId: string;
  productId: string;
  billingMode: VariantBillingMode;
  durationDays: number | null;
  size: bigint | null;
  price: { amount: Prisma.Decimal; currencyCode: string } | null;
};

export type CandidateInputs = {
  predictions: DecisionPrediction[];
  grants: ReadonlyMap<string, CandidateGrant>;
  /** Every Grant's own plan and the other plans of the same products. */
  plans: ReadonlyMap<string, PlanOption>;
  /** A Grant's wholesale leg (F-038-p): the rate it locked. None for the platform's own sales. */
  wholesale?: ReadonlyMap<string, WholesaleRate>;
};

export type EngineCandidate = ActionCandidate & {
  actionType: CandidateType;
  grantId: string;
  targetVariantId: string;
  expectedMargin: { amount: string; currencyCode: string };
};

export type Margin = { amount: string; currencyCode: string; reason: Reason };

export function expectedMargin(probability: number, price: { amount: Prisma.Decimal; currencyCode: string }, cost: Prisma.Decimal | null): Margin {
  const p = new Prisma.Decimal(probability.toFixed(4));
  const amount = price.amount.minus(cost ?? 0).times(p);
  return {
    amount: amount.toFixed(2),
    currencyCode: price.currencyCode,
    reason: {
      code: 'expected_margin',
      probability: p.toNumber(),
      price: price.amount.toFixed(2),
      cost: cost ? cost.toFixed(2) : null,
      costKnown: cost !== null,
      currencyCode: price.currencyCode,
      losingMoney: amount.isNegative(),
    },
  };
}

const grantOf = (p: DecisionPrediction): string | null => {
  const id = p.reasons[0]?.['grantId'];
  return typeof id === 'string' ? id : null;
};

/** Plans of the same product, mode and length as `current` — what a resize may move to. */
export function siblingPlans(plans: ReadonlyMap<string, PlanOption>, current: PlanOption): PlanOption[] {
  return [...plans.values()]
    .filter((p) => p.productId === current.productId && p.billingMode === current.billingMode && p.durationDays === current.durationDays)
    .filter((p) => p.price !== null && p.size !== null && p.size > BigInt(0))
    .sort((a, b) => ((a.size as bigint) < (b.size as bigint) ? -1 : (a.size as bigint) > (b.size as bigint) ? 1 : 0));
}

/** The smallest bigger plan holding `factor` × the current bag; the largest bigger one if none does; null if none is bigger. */
function biggerPlan(plans: ReadonlyMap<string, PlanOption>, current: PlanOption, factor: number): PlanOption | null {
  if (current.size === null) return null;
  const bigger = siblingPlans(plans, current).filter((p) => (p.size as bigint) > (current.size as bigint));
  const needed = (current.size * BigInt(Math.round(factor * 10_000))) / BigInt(10_000);
  return bigger.find((p) => (p.size as bigint) >= needed) ?? bigger[bigger.length - 1] ?? null;
}

/** F-1514: the smallest smaller plan holding `share` × the current bag with headroom; null if none fits. */
function smallerPlan(plans: ReadonlyMap<string, PlanOption>, current: PlanOption, share: number): PlanOption | null {
  if (current.size === null) return null;
  const needed = (current.size * BigInt(Math.ceil(share * RESIZE_DOWN_HEADROOM * 10_000))) / BigInt(10_000);
  return siblingPlans(plans, current).find((p) => (p.size as bigint) >= needed && (p.size as bigint) < (current.size as bigint)) ?? null;
}

export function candidatesFor(input: CandidateInputs, now: Date): EngineCandidate[] {
  const t = now.getTime();
  const lead = SUGGEST_LEAD_DAYS * DAY_MS;
  const byGrant = new Map<string, Partial<Record<AiPredictionKind, DecisionPrediction>>>();
  for (const p of input.predictions) {
    const g = grantOf(p);
    if (!g) continue;
    byGrant.set(g, { ...byGrant.get(g), [p.kind]: p });
  }

  const out: EngineCandidate[] = [];
  for (const [grantId, kinds] of byGrant) {
    const grant = input.grants.get(grantId);
    const current = grant?.variantId ? input.plans.get(grant.variantId) : undefined;
    if (!grant || !current) continue;

    const exhaustion = kinds.meter_exhaustion?.predictedAt ?? null;
    const moments = [grant.endsAt, exhaustion].filter((d): d is Date => d !== null && d.getTime() > t);
    const deadline = moments.sort((a, b) => a.getTime() - b.getTime())[0];
    if (!deadline || deadline.getTime() - t > lead) continue;

    const renewal = kinds.renewal_probability;
    const size = kinds.right_size;
    let chosen: { type: CandidateType; prediction: DecisionPrediction; target: PlanOption } | null = null;
    if (size?.reasons[0]?.code === 'size_up' && size.value !== null) {
      const target = biggerPlan(input.plans, current, size.value);
      if (target) chosen = { type: 'resize_up', prediction: size, target };
    }
    // F-1514: an over-buyer is offered the smaller plan at renewal, never earlier — its deadline is the Grant's end.
    if (size?.reasons[0]?.code === 'size_down' && size.value !== null && grant.endsAt && grant.endsAt.getTime() - t <= lead) {
      const target = smallerPlan(input.plans, current, size.value);
      if (target) chosen = { type: 'resize_down', prediction: size, target };
    }
    // No right size to offer: the same plan again, when the Grant itself is ending.
    if (!chosen && renewal && grant.endsAt && grant.endsAt.getTime() - t <= lead && current.price) {
      chosen = { type: 'renew', prediction: renewal, target: current };
    }
    if (!chosen?.target.price) continue;

    const probability = renewal?.value ?? chosen.prediction.confidence;
    const costed = wholesaleCost(chosen.target, input.wholesale?.get(grantId) ?? null);
    const margin = expectedMargin(probability, chosen.target.price, costed.cost);
    out.push({
      actionType: chosen.type,
      confidence: chosen.prediction.confidence,
      predictionId: chosen.prediction.id,
      templateKey: SUGGESTION_TEMPLATE_KEY[chosen.type],
      grantId,
      targetVariantId: chosen.target.variantId,
      deadline,
      expectedMargin: { amount: margin.amount, currencyCode: margin.currencyCode },
      reasons: [
        {
          code: 'suggest_variant',
          grantId,
          fromVariantId: current.variantId,
          variantId: chosen.target.variantId,
          price: chosen.target.price.amount.toFixed(2),
          currencyCode: chosen.target.price.currencyCode,
        },
        costed.reason,
        margin.reason,
        ...chosen.prediction.reasons,
      ],
    });
  }
  return out;
}
