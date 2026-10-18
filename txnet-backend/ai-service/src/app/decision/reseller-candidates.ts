import { Prisma } from '@prisma/client';
import { moneyText } from '@txnet-backend/shared-core';

import type { Reason } from '../profile/predictions';
import { SUGGEST_LEAD_DAYS, type EngineCandidate } from './candidates';
import { expectedMargin } from './margin';

const DAY_MS = 86_400_000;

/** The package named must hold the window's projected use with this much to spare (as `RESIZE_DOWN_HEADROOM`). */
export const UPGRADE_HEADROOM = 1.25;
/** The template a reseller's upgrade is told by (worker `suggestionPackageUpgrade`). */
export const PACKAGE_UPGRADE_TEMPLATE_KEY = 'notifications.suggestion.package_upgrade';
/** The template a reseller's billing-wallet top-up is told by (worker `suggestionResellerTopUp`). */
export const RESELLER_TOP_UP_TEMPLATE_KEY = 'notifications.suggestion.reseller_top_up';

/** A package the platform sells resellers, with what it includes of each quota. */
export type PackageOption = {
  id: string;
  name: string;
  isActive: boolean;
  monthlyPrice: Prisma.Decimal | null;
  yearlyPrice: Prisma.Decimal | null;
  currencyCode: string;
  /** `package_limit` rows by key; `null` = no limit. A key with no row falls to the platform's number — the same for every package. */
  limits: Map<string, number | null>;
  /** `package_product` rows by product: what each window includes; a product with no row is not sold on it. */
  products: Map<string, { day: number | null; week: number | null; month: number | null }>;
};

export type ResellerUpgradeInputs = {
  /** The reseller's `quota_exhaustion` (F-038-o1); its first reason is the soonest window. */
  prediction: { id: string; predictedAt: Date | null; confidence: number; reasons: Reason[] } | null;
  packageId: string | null;
  billingModel: string;
  packages: PackageOption[];
  /** Registry keys the platform's staff set for this reseller alone (`reseller_limit`): no package changes them. */
  ownLimitKeys: Set<string>;
};

const priceFor = (p: PackageOption, billingModel: string): Prisma.Decimal | null =>
  billingModel === 'subscription_monthly' ? p.monthlyPrice : billingModel === 'subscription_yearly' ? p.yearlyPrice : null;

const PERIODS = ['day', 'week', 'month'] as const;

/**
 * The upgrade (F-038-o4, ADR-0109 point 4): told inside the lead time
 * (`SUGGEST_LEAD_DAYS`) before the soonest window at risk runs out, and
 * before that window ends — the deadline, since a new window starts empty.
 *
 * The package named: pricier than the reseller's own for its period, in the
 * same currency (ADR-0107 point 9: an upgrade applies at once; a cheaper one
 * waits for the renewal and unlocks nothing now), whose number for this
 * quota is above today's. Of those, the cheapest that holds the window's
 * projected use × {@link UPGRADE_HEADROOM} — else the biggest step up.
 * A key the platform set for this reseller alone is none: no package moves it.
 *
 * Expected margin: P × (new price − current price) — what the upgrade adds;
 * the platform's own sale has no cost to subtract (as a user's platform plan).
 */
export function packageUpgradeCandidate(input: ResellerUpgradeInputs, now: Date): EngineCandidate | null {
  const p = input.prediction;
  if (!p?.predictedAt || p.predictedAt.getTime() > now.getTime() + SUGGEST_LEAD_DAYS * DAY_MS) return null;
  const w = p.reasons[0];
  const meter = w?.['meter'];
  const period = w?.['period'];
  const included = w?.['included'];
  const used = w?.['used'];
  if (typeof meter !== 'string' || typeof included !== 'number' || typeof used !== 'number' || !(PERIODS as readonly unknown[]).includes(period)) return null;
  const deadline = typeof w['periodEnd'] === 'string' ? new Date(w['periodEnd']) : null;
  if (!deadline || deadline.getTime() <= now.getTime()) return null;

  const product = meter.startsWith('product:') ? meter.slice('product:'.length) : null;
  if (!product && input.ownLimitKeys.has(meter)) return null;
  const current = input.packages.find((x) => x.id === input.packageId);
  const currentPrice = current ? priceFor(current, input.billingModel) : null;
  if (!current || !currentPrice) return null;

  const perDay = typeof w['perDay'] === 'number' ? w['perDay'] : 0;
  const overage = typeof w['overageQty'] === 'number' ? w['overageQty'] : 0;
  let projected = used + perDay * ((deadline.getTime() - now.getTime()) / DAY_MS);
  if (w.code === 'quota_full') projected = Math.max(projected, used + overage);
  const need = Math.ceil(Math.max(projected, included + 1) * UPGRADE_HEADROOM);

  const includedIn = (x: PackageOption): number | null | undefined => {
    if (product) {
      const row = x.products.get(product);
      return row ? row[period as (typeof PERIODS)[number]] : undefined;
    }
    return x.limits.has(meter) ? (x.limits.get(meter) as number | null) : undefined;
  };
  const steps = input.packages.flatMap((x) => {
    const price = priceFor(x, input.billingModel);
    const inc = includedIn(x);
    if (!x.isActive || x.id === current.id || !price || x.currencyCode !== current.currencyCode || !price.gt(currentPrice)) return [];
    if (inc === undefined || (inc !== null && inc <= included)) return [];
    return [{ x, price, inc }];
  });
  const holds = steps.filter((s) => s.inc === null || s.inc >= need).sort((a, b) => a.price.comparedTo(b.price));
  const size = (n: number | null) => (n === null ? Infinity : n);
  const best = holds[0] ?? [...steps].sort((a, b) => size(b.inc) - size(a.inc) || a.price.comparedTo(b.price))[0];
  if (!best) return null;

  const margin = expectedMargin(p.confidence, { amount: best.price.minus(currentPrice), currencyCode: current.currencyCode }, null);
  return {
    actionType: 'resize_up',
    confidence: p.confidence,
    predictionId: p.id,
    templateKey: PACKAGE_UPGRADE_TEMPLATE_KEY,
    deadline,
    expectedMargin: { amount: margin.amount, currencyCode: margin.currencyCode },
    costKnown: false,
    reasons: [
      {
        code: 'suggest_package',
        fromPackageId: current.id,
        packageId: best.x.id,
        price: moneyText(best.price),
        currencyCode: current.currencyCode,
        billingModel: input.billingModel,
        meter,
        period: period as string,
        included,
        used,
        newIncluded: best.inc,
        need,
      },
      margin.reason,
      ...p.reasons,
    ],
  };
}

/**
 * The top-up (F-1525-c): a reseller's `wallet_need` (F-1525-a) whose run-out
 * is inside the lead time and still ahead — the deadline — with something to
 * top up. Help, never a sale: the money is the reseller's own, so it carries
 * no margin and ranks as zero beside an upgrade (as `usage_alert`). The
 * amount travels as `suggest_top_up`, a decimal string with its currency
 * (C-02), as a user's top-up does.
 */
export function resellerTopUpCandidate(
  p: { id: string; predictedAt: Date | null; confidence: number; value: Prisma.Decimal | null; currencyCode: string | null; reasons: Reason[] } | null,
  now: Date,
): EngineCandidate | null {
  if (!p?.predictedAt || !p.value || !p.currencyCode || p.value.lte(0)) return null;
  if (p.predictedAt.getTime() <= now.getTime() || p.predictedAt.getTime() > now.getTime() + SUGGEST_LEAD_DAYS * DAY_MS) return null;
  return {
    actionType: 'top_up_wallet',
    confidence: p.confidence,
    predictionId: p.id,
    templateKey: RESELLER_TOP_UP_TEMPLATE_KEY,
    deadline: p.predictedAt,
    reasons: [{ code: 'suggest_top_up', amount: moneyText(p.value), currencyCode: p.currencyCode }, ...p.reasons],
  };
}
