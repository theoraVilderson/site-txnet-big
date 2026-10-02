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
 * The same holds for the wallet (F-038-k): a wallet short of the next two
 * renewals is told to top up (`top_up_wallet`) *instead of* to renew. An
 * account with no active Grant is told its last plan again (`win_back`,
 * F-038-n) on the day a 14 / 30 / 60-day window closes. A renewal predicted
 * under 0.5 is offered one of the tenant's discounts instead (`retain_offer`,
 * F-038-f2, ADR-0110). A gateway payment left unfinished gets one help
 * message (`checkout_help`, F-038-m) — about no Grant.
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
 * F-038-n: `win_back` is told on the day its window closes — "14 / 30 / 60
 * days without an active Grant" (point 7), not a week before, while the user
 * may still be deciding. The window's close is the deadline.
 */
export const WIN_BACK_LEAD_DAYS = 1;

/**
 * F-038-m: help with an unfinished payment comes after the user had time to
 * retry on their own, and not once the moment has passed. Its confidence is
 * fixed: the attempt is a fact, not a prediction.
 */
export const CHECKOUT_HELP_WAIT_MS = 30 * 60_000;
export const CHECKOUT_HELP_DEADLINE_MS = 48 * 3_600_000;
const CHECKOUT_HELP_CONFIDENCE = 0.7;

/** ADR-0109 point 9: a discount only where the renewal without it is predicted under this. */
export const RETAIN_OFFER_BELOW = 0.5;

/**
 * F-1514: a smaller plan must hold the most they used in a period plus this
 * much — a plan cut to the byte runs out in the next busy month, and the
 * buyer blames the seller who suggested it.
 */
export const RESIZE_DOWN_HEADROOM = 1.25;

/** The types this file proposes. Each new action row adds its own. */
export const CANDIDATE_TYPES = ['renew', 'resize_up', 'resize_down', 'top_up_wallet', 'win_back', 'retain_offer', 'checkout_help'] as const satisfies readonly AiActionType[];
export type CandidateType = (typeof CANDIDATE_TYPES)[number];

/** C-07: a key chosen at runtime comes from an exhaustive Record. */
export const SUGGESTION_TEMPLATE_KEY: Record<CandidateType, string> = {
  renew: BackendI18nKeys.notifications.suggestion.renew,
  resize_up: BackendI18nKeys.notifications.suggestion.resize_up,
  resize_down: BackendI18nKeys.notifications.suggestion.resize_down,
  top_up_wallet: BackendI18nKeys.notifications.suggestion.top_up_wallet,
  win_back: BackendI18nKeys.notifications.suggestion.win_back,
  retain_offer: BackendI18nKeys.notifications.suggestion.retain_offer,
  checkout_help: BackendI18nKeys.notifications.suggestion.checkout_help,
};

export type DecisionPrediction = {
  id: string;
  kind: AiPredictionKind;
  value: number | null;
  predictedAt: Date | null;
  confidence: number;
  reasons: Reason[];
  /** `value` as stored, when it is an amount (`wallet_need`): a decimal string with its currency — never the float (C-02). */
  amount?: string | null;
  currencyCode?: string | null;
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

/**
 * A `retain_offer` offer the tenant runs (F-038-f2, ADR-0110), with its
 * template coupon's terms when it targets one. A variant offer discounts that
 * plan only; a template offer any plan — its service scope is billing's to
 * hold when it issues the coupon (F-038-f3).
 */
export type OfferOption = {
  id: string;
  variantId: string | null;
  template: { discountType: string; discountValue: Prisma.Decimal; maxDiscountCap: Prisma.Decimal | null; currencyCode: string } | null;
  maxDiscountPercent: Prisma.Decimal;
  currencyCode: string;
};

/** A gateway payment the user started and did not finish (F-038-m): `billing.payment_transaction`, C-02. */
export type CheckoutAttempt = { paymentId: string; status: 'failed' | 'expired'; at: Date; amount: string; currencyCode: string };

export type CandidateInputs = {
  predictions: DecisionPrediction[];
  grants: ReadonlyMap<string, CandidateGrant>;
  /** Every Grant's own plan and the other plans of the same products. */
  plans: ReadonlyMap<string, PlanOption>;
  /** A Grant's wholesale leg (F-038-p): the rate it locked. None for the platform's own sales. */
  wholesale?: ReadonlyMap<string, WholesaleRate>;
  /** The tenant's active `retain_offer` offers (F-038-f2). */
  offers?: readonly OfferOption[];
  /** Offers this account was already given (any status but stopped): each once per account. */
  usedOfferIds?: ReadonlySet<string>;
  /** F-038-m: the account's unfinished gateway payments of the last two days, and its last successful one. */
  checkouts?: readonly CheckoutAttempt[];
  lastPaidAt?: Date | null;
};

export type EngineCandidate = ActionCandidate & {
  actionType: CandidateType;
  /** None for a suggestion about no service (`checkout_help`). */
  grantId?: string;
  targetVariantId?: string;
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

type Price = NonNullable<PlanOption['price']>;
type Discount = { offer: OfferOption; amount: Prisma.Decimal; percent: Prisma.Decimal };

/**
 * What `offer` takes off `plan` (F-038-f2): the lower of the offer's cap and
 * the template's own discount (its money cap too), in the plan's currency
 * only — the engine converts nothing. Null when it does not apply.
 */
export function offerDiscount(offer: OfferOption, plan: PlanOption): Discount | null {
  const price = plan.price;
  if (!price || price.amount.lte(0) || offer.currencyCode !== price.currencyCode) return null;
  if (offer.variantId !== null && offer.variantId !== plan.variantId) return null;
  let amount = price.amount.times(offer.maxDiscountPercent).dividedBy(100);
  const t = offer.template;
  if (t) {
    if (t.currencyCode !== price.currencyCode) return null;
    if (t.discountType === 'percentage') {
      amount = Prisma.Decimal.min(amount, price.amount.times(t.discountValue).dividedBy(100));
      if (t.maxDiscountCap !== null) amount = Prisma.Decimal.min(amount, t.maxDiscountCap);
    } else if (t.discountType === 'fixed_amount') {
      amount = Prisma.Decimal.min(amount, t.discountValue);
    } else {
      return null;
    }
  }
  amount = amount.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  if (amount.lte(0)) return null;
  return { offer, amount, percent: amount.times(100).dividedBy(price.amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN) };
}

/** The unused offer giving the least away on `plan` — the highest margin; null when none applies. */
function bestOffer(input: CandidateInputs, plan: PlanOption): Discount | null {
  const used = input.usedOfferIds ?? new Set<string>();
  const fits = (input.offers ?? [])
    .filter((o) => !used.has(o.id))
    .map((o) => offerDiscount(o, plan))
    .filter((d): d is Discount => d !== null);
  return fits.sort((a, b) => a.amount.comparedTo(b.amount))[0] ?? null;
}

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

/**
 * F-038-m (ADR-0109 point 9): one help message for the latest unfinished
 * gateway payment — after {@link CHECKOUT_HELP_WAIT_MS}, before
 * {@link CHECKOUT_HELP_DEADLINE_MS}, and only while nothing was paid since.
 * Which other gateway to name is billing's, at delivery. It is help, never a
 * sale: its margin is zero, so it never outranks one.
 */
export function checkoutHelpFor(input: CandidateInputs, now: Date): EngineCandidate | null {
  const t = now.getTime();
  const latest = [...(input.checkouts ?? [])].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!latest) return null;
  const at = latest.at.getTime();
  if (t - at < CHECKOUT_HELP_WAIT_MS || t - at >= CHECKOUT_HELP_DEADLINE_MS) return null;
  if (input.lastPaidAt && input.lastPaidAt.getTime() > at) return null;
  return {
    actionType: 'checkout_help',
    confidence: CHECKOUT_HELP_CONFIDENCE,
    templateKey: SUGGESTION_TEMPLATE_KEY.checkout_help,
    deadline: new Date(at + CHECKOUT_HELP_DEADLINE_MS),
    expectedMargin: { amount: '0.00', currencyCode: latest.currencyCode },
    reasons: [
      { code: 'checkout_attempt', paymentId: latest.paymentId, status: latest.status, amount: latest.amount, currencyCode: latest.currencyCode, at: new Date(at).toISOString() },
      { code: 'help_not_sale' },
    ],
  };
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

    // F-038-n: an account with no active Grant has only this prediction — its last Grant's plan, once per window.
    const winBack = kinds.win_back_window;
    if (winBack) {
      const closes = winBack.predictedAt;
      if (!closes || !current.price || closes.getTime() <= t || closes.getTime() - t > WIN_BACK_LEAD_DAYS * DAY_MS) continue;
      out.push(candidate({ type: 'win_back', prediction: winBack, grantId, current, target: current, deadline: closes, probability: winBack.confidence }, input));
      continue;
    }

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

    // F-038-f2 (ADR-0110 point 3): a renewal unlikely without a discount is offered one of the tenant's
    // offers instead — still one suggestion per Grant; ahead of a top-up, never instead of a resize.
    const discount = chosen.type === 'renew' && renewal?.value != null && renewal.value < RETAIN_OFFER_BELOW ? bestOffer(input, current) : null;
    if (discount && renewal) {
      const { offer, amount, percent } = discount;
      const reason = { code: 'suggest_offer', grantId, offerId: offer.id, discountPercent: percent.toFixed(2), discount: amount.toFixed(2), currencyCode: offer.currencyCode };
      out.push(candidate({ type: 'retain_offer', prediction: renewal, grantId, current, target: current, deadline, probability, offerId: offer.id, discount: amount, extra: [reason] }, input));
      continue;
    }

    // F-038-k (user, 2026-10-02): one suggestion per Grant — a wallet short of the next two renewals
    // is told to top up *instead of* to renew, in the plan's own currency only. A resize is never displaced.
    const wallet = kinds.wallet_need;
    const topUp =
      chosen.type === 'renew' && wallet?.amount && wallet.currencyCode === chosen.target.price.currencyCode
        ? { amount: wallet.amount, currencyCode: wallet.currencyCode }
        : null;
    if (topUp && wallet) chosen = { type: 'top_up_wallet', prediction: wallet, target: current };

    // A top-up is worth the renewal it funds: the renewal's probability, the plan's margin.
    const extra = topUp ? [{ code: 'suggest_top_up', grantId, ...topUp }] : [];
    out.push(candidate({ type: chosen.type, prediction: chosen.prediction, grantId, current, target: chosen.target, deadline, probability, extra }, input));
  }
  const help = checkoutHelpFor(input, now);
  if (help) out.push(help);
  return out;
}

type CandidateSpec = {
  type: CandidateType;
  prediction: DecisionPrediction;
  grantId: string;
  current: PlanOption;
  target: PlanOption;
  deadline: Date;
  probability: number;
  /** F-038-f2: the offer it carries, and what that takes off the seller's margin. */
  offerId?: string;
  discount?: Prisma.Decimal;
  extra?: Reason[];
};

/** One Grant's candidate naming `target`, its margin at `probability` (C-02), and why. */
function candidate(spec: CandidateSpec, input: CandidateInputs): EngineCandidate {
  const { type, prediction, grantId, current, target, deadline, probability, offerId, discount, extra = [] } = spec;
  const price = target.price as Price;
  const costed = wholesaleCost(target, input.wholesale?.get(grantId) ?? null);
  // The seller gives the discount: the margin is on the price after it.
  const paid: Price = discount ? { amount: price.amount.minus(discount), currencyCode: price.currencyCode } : price;
  const margin = expectedMargin(probability, paid, costed.cost);
  return {
    actionType: type,
    ...(offerId ? { offerId } : {}),
    confidence: prediction.confidence,
    predictionId: prediction.id,
    templateKey: SUGGESTION_TEMPLATE_KEY[type],
    grantId,
    targetVariantId: target.variantId,
    deadline,
    expectedMargin: { amount: margin.amount, currencyCode: margin.currencyCode },
    reasons: [
      {
        code: 'suggest_variant',
        grantId,
        fromVariantId: current.variantId,
        variantId: target.variantId,
        price: price.amount.toFixed(2),
        currencyCode: price.currencyCode,
      },
      costed.reason,
      margin.reason,
      ...extra,
      ...prediction.reasons,
    ],
  };
}
