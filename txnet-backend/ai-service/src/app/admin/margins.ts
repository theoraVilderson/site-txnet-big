import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { METER_KEYS, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { pricesInForce } from '../decision/decision-reader';
import { wholesaleCost, type WholesaleRate } from '../decision/margin';
import type { Reason } from '../profile/predictions';
import { AiReaderPrisma } from '../prisma/prisma.service';

/**
 * F-1528 / ADR-0109 point 8: the reseller's margin per plan, for the AI page.
 *
 * - **Cost** is the plan at the package's rate **in force now** — what a new
 *   sale or a renewal would lock (entitlement `contract.package-wholesale.md`):
 *   `vpn.traffic` for a bag, `vpn.unlimited.time` for an unlimited plan,
 *   through the same `wholesaleCost` the engine's margin step uses (F-038-p).
 *   **Unknown**, never guessed — no package rate, a rate in another currency
 *   (C-02), a metered plan (charged per use, no leg) — and an unknown cost
 *   flags nothing.
 * - **Losing money**: the price is under that cost.
 * - **Grants**: the plan's active Grants, and how many lose money at the rate
 *   they locked — the accounts the engine's margin step stops.
 *
 * Read on request, nothing stored. The alert sent to the reseller's staff is F-1528-b.
 */

const READ_TIMEOUT_MS = 30_000;
const BAG_QUOTA_METRIC = 'traffic_bytes';

type Money = { amount: string; currencyCode: string };

export type MarginPlan = {
  variantId: string;
  productId: string;
  sku: string;
  /** The variant's own catalog name, or its product's; the page words it as the shop does. */
  nameKey: string;
  billingMode: 'prepaid' | 'metered';
  durationDays: number | null;
  /** The bag in bytes; null for an unlimited or a metered plan. */
  size: bigint | null;
  unlimited: boolean;
  price: { amount: Prisma.Decimal; currencyCode: string } | null;
};

/** A row of `ai.reader_package_rate`: the bound tenant's package, in the package's currency, active. */
export type PackageRate = WholesaleRate & { effectiveFrom: Date; createdAt: Date };

/** Active Grants on one plan that locked the same leg (null: none). */
export type GrantGroup = { variantId: string; leg: WholesaleRate | null; count: number };

export type PlanMargin = {
  variantId: string;
  productId: string;
  sku: string;
  nameKey: string;
  billingMode: 'prepaid' | 'metered';
  durationDays: number | null;
  size: string | null;
  unlimited: boolean;
  price: Money;
  cost: Money | null;
  margin: Money | null;
  losingMoney: boolean;
  reasons: Reason[];
  grants: { active: number; losing: number; costUnknown: number };
};

const money = (amount: Prisma.Decimal, currencyCode: string): Money => ({ amount: amount.toFixed(2), currencyCode });

/** The newest row at or before `now` for the meter; two from one instant by the one written last. */
export function rateInForce(rows: readonly PackageRate[], meterKey: string, now: Date): WholesaleRate | null {
  let best: PackageRate | null = null;
  for (const r of rows) {
    if (r.meterKey !== meterKey || r.effectiveFrom > now) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom || (r.effectiveFrom.getTime() === best.effectiveFrom.getTime() && r.createdAt > best.createdAt)) best = r;
  }
  return best ? { meterKey: best.meterKey, unitSize: best.unitSize, unitPrice: best.unitPrice, currencyCode: best.currencyCode } : null;
}

function costOf(plan: MarginPlan, rate: WholesaleRate | null) {
  if (plan.billingMode === 'metered') return { cost: null, reason: { code: 'cost_unknown', why: 'metered' } as Reason };
  return wholesaleCost(plan, rate);
}

export function planMargins(plans: readonly MarginPlan[], rates: readonly PackageRate[], grants: readonly GrantGroup[], now: Date): PlanMargin[] {
  const out: PlanMargin[] = [];
  for (const plan of plans) {
    if (!plan.price) continue;
    const meterKey = plan.unlimited ? METER_KEYS.unlimitedTime : METER_KEYS.vpnTraffic;
    const { cost, reason } = costOf(plan, rateInForce(rates, meterKey, now));
    const margin = cost ? plan.price.amount.minus(cost) : null;

    const counted = { active: 0, losing: 0, costUnknown: 0 };
    for (const g of grants) {
      if (g.variantId !== plan.variantId) continue;
      counted.active += g.count;
      const locked = costOf(plan, g.leg).cost;
      if (!locked) counted.costUnknown += g.count;
      else if (plan.price.amount.lessThan(locked)) counted.losing += g.count;
    }

    out.push({
      variantId: plan.variantId,
      productId: plan.productId,
      sku: plan.sku,
      nameKey: plan.nameKey,
      billingMode: plan.billingMode,
      durationDays: plan.durationDays,
      size: plan.size === null ? null : plan.size.toString(),
      unlimited: plan.unlimited,
      price: money(plan.price.amount, plan.price.currencyCode),
      cost: cost ? money(cost, plan.price.currencyCode) : null,
      margin: margin ? money(margin, plan.price.currencyCode) : null,
      losingMoney: !!margin?.isNegative(),
      reasons: [reason],
      grants: counted,
    });
  }
  // Losing first, then the thinnest known margin, then the unknown; a tie by id, so the page is stable.
  const rank = (p: PlanMargin) => (p.losingMoney ? 0 : p.margin ? 1 : 2);
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.margin && b.margin ? new Prisma.Decimal(a.margin.amount).comparedTo(b.margin.amount) : 0) ||
      a.variantId.localeCompare(b.variantId),
  );
}

/** A prepaid variant's traffic: a bag, unlimited (`limit` 0, F-111-q), or not stated. */
function trafficOf(quotas: Prisma.JsonValue): { size: bigint | null; unlimited: boolean } {
  const limit = (quotas as Record<string, { limit?: unknown }> | null)?.[BAG_QUOTA_METRIC]?.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) return { size: null, unlimited: false };
  return limit === 0 ? { size: null, unlimited: true } : { size: BigInt(limit), unlimited: false };
}

/**
 * The reads behind `GET /api/ai/admin/margins`, all through `txnet_ai_reader`
 * under the tenant's RLS (invariant 7): the plans it sells (active, public,
 * priced — its own price before the platform's), its package's rates through
 * `ai.reader_package_rate`, and its active Grants grouped by the leg they locked.
 */
@Injectable()
export class Margins {
  constructor(private readonly reader: AiReaderPrisma) {}

  async report(tenantId: string, now: Date): Promise<{ items: PlanMargin[] }> {
    const read = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(
        this.reader,
        async (tx) => {
          const variants = await tx.productVariant.findMany({
            where: { isActive: true, visibility: 'public' },
            select: { id: true, productId: true, sku: true, nameKey: true, billingMode: true, durationDays: true, quotas: true, product: { select: { nameKey: true } } },
          });
          const prices = await tx.price.findMany({
            where: { variantId: { in: variants.map((v) => v.id) }, isActive: true, effectiveFrom: { lte: now } },
            select: { variantId: true, tenantId: true, amount: true, currencyCode: true },
            orderBy: { effectiveFrom: 'desc' },
          });
          const rates = await tx.$queryRaw<PackageRate[]>`
            SELECT "meterKey", "unitSize", "unitPrice", "currencyCode", "effectiveFrom", "createdAt" FROM ai.reader_package_rate`;
          const grants = await tx.$queryRaw<Array<{ variantId: string; meterKey: string | null; unitSize: bigint | null; unitPrice: Prisma.Decimal | null; currencyCode: string | null; count: bigint }>>`
            SELECT g."variantId", w."meterKey", w."unitSize", w."unitPrice", w."currencyCode", COUNT(*) AS "count"
            FROM entitlement."grant" g
            LEFT JOIN entitlement.grant_wholesale w ON w."grantId" = g."id"
            WHERE g."status" = 'active' AND g."variantId" IS NOT NULL
            GROUP BY 1, 2, 3, 4, 5`;
          return { variants, prices, rates, grants };
        },
        { timeout: READ_TIMEOUT_MS },
      ),
    );

    const price = pricesInForce(read.prices, tenantId);
    const plans: MarginPlan[] = read.variants.map((v) => ({
      variantId: v.id,
      productId: v.productId,
      sku: v.sku,
      nameKey: v.nameKey ?? v.product.nameKey,
      billingMode: v.billingMode,
      durationDays: v.durationDays,
      ...(v.billingMode === 'prepaid' ? trafficOf(v.quotas) : { size: null, unlimited: false }),
      price: price.get(v.id) ?? null,
    }));
    const grants: GrantGroup[] = read.grants.map((g) => ({
      variantId: g.variantId,
      leg: g.meterKey && g.unitSize !== null && g.unitPrice && g.currencyCode ? { meterKey: g.meterKey, unitSize: g.unitSize, unitPrice: g.unitPrice, currencyCode: g.currencyCode } : null,
      count: Number(g.count),
    }));
    return { items: planMargins(plans, read.rates, grants, now) };
  }
}
