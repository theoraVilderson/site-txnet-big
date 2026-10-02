import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { METER_KEYS, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { Reason } from '../profile/predictions';
import { AiReaderPrisma, PrismaService } from '../prisma/prisma.service';
import type { MarginPlan } from './margins';

/**
 * F-1527 / ADR-0109 points 6, 9: plan-layout suggestions for the reseller's
 * AI page, from how much the users on each plan actually use per period.
 *
 * - **Families.** The bag plans the tenant sells (active, public, prepaid, a
 *   traffic size) grouped by product, mode and length — the plans a user can
 *   move between, as a resize does. Metered and unlimited plans have no bag.
 * - **Use per period** of each active Grant: its `vpn.traffic` readings
 *   (`ai.meter_reading`, the engine's own — no network data) over the last
 *   {@link LAYOUT_WINDOW_DAYS} days, scaled to the plan's length. Only a Grant
 *   whose readings reach back the whole window is measured. A Grant at 98 % of
 *   its bag is **at the cap**: what it would have used is not known.
 * - **Suggestions**, only from {@link LAYOUT_MIN_MEASURED} measured users:
 *   `add_smaller` — 40 % of a plan's users use under 40 % of it, and no plan
 *   between their need and it is sold: their 75th percentile × 1.25, rounded
 *   up; `add_bigger` — a quarter of the largest plan's users reach its cap:
 *   1.5 × it, a floor (`demandCensored`); `no_takers` — a plan nobody holds.
 *   A size, never a price: the price is the reseller's (point 9).
 *
 * Read on request, nothing stored; reasons are codes and numbers, the page words them.
 */

export const LAYOUT_WINDOW_DAYS = 30;
export const LAYOUT_MIN_MEASURED = 10;
/** As `right_size` (point 7): a period used under this share of its bag is over-bought. */
const UNDER_SHARE = 0.4;
/** A smaller plan is suggested once this share of a plan's users over-buy it. */
const UNDER_USERS_SHARE = 0.4;
const AT_CAP_SHARE = 0.98;
const AT_CAP_USERS_SHARE = 0.25;
/** As `resize_down` (F-1514): a size cut to the byte runs out in the next busy month. */
const SMALLER_HEADROOM = 1.25;
const BIGGER_FACTOR = 1.5;
const GIB = BigInt(1024 ** 3);
const DAY_MS = 86_400_000;

export type LayoutPlan = Pick<MarginPlan, 'variantId' | 'productId' | 'sku' | 'nameKey' | 'billingMode' | 'durationDays' | 'size' | 'unlimited'>;

/** One active Grant: its plan, its bag, and what its readings say. */
export type LayoutGrant = { variantId: string; usedInWindow: bigint; firstReadingAt: Date | null; purchasedBytes: bigint; consumedBytes: bigint };

type Bytes = string;
export type LayoutPlanRow = {
  variantId: string;
  sku: string;
  nameKey: string;
  size: Bytes;
  active: number;
  measured: number;
  /** Use per period of the measured Grants; null with none. */
  usage: { p25: Bytes; p50: Bytes; p75: Bytes; p90: Bytes } | null;
  under: number;
  atCap: number;
};
export type LayoutFamily = { productId: string; billingMode: 'prepaid' | 'metered'; durationDays: number | null; plans: LayoutPlanRow[]; suggestions: Reason[] };

/** Nearest rank: the smallest value with at least `q` of the values at or under it. */
function quantile(sorted: readonly bigint[], q: number): bigint {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/** Up to a whole 5 GiB, or a whole GiB under 5. */
function roundSize(bytes: bigint): bigint {
  const step = bytes >= BigInt(5) * GIB ? BigInt(5) * GIB : GIB;
  return ((bytes + step - BigInt(1)) / step) * step;
}

const scale = (b: bigint, factor: number) => (b * BigInt(Math.round(factor * 10_000))) / BigInt(10_000);
const share = (n: number, of: number) => Number((n / of).toFixed(2));
const byBigint = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function planLayout(plans: readonly LayoutPlan[], grants: readonly LayoutGrant[], now: Date): { families: LayoutFamily[] } {
  const since = now.getTime() - LAYOUT_WINDOW_DAYS * DAY_MS;
  const bags = plans.filter((p): p is LayoutPlan & { size: bigint } => p.billingMode === 'prepaid' && !p.unlimited && p.size !== null && p.size > BigInt(0));
  const families = new Map<string, Array<LayoutPlan & { size: bigint }>>();
  for (const p of bags) {
    const key = `${p.productId}|${p.billingMode}|${p.durationDays ?? ''}`;
    families.set(key, [...(families.get(key) ?? []), p]);
  }

  const out: LayoutFamily[] = [];
  for (const members of families.values()) {
    members.sort((a, b) => byBigint(a.size, b.size) || a.variantId.localeCompare(b.variantId));
    const { productId, billingMode, durationDays } = members[0];
    const periodScale = (durationDays ?? LAYOUT_WINDOW_DAYS) / LAYOUT_WINDOW_DAYS;

    const measuredOf = new Map<string, Array<{ use: bigint; atCap: boolean }>>();
    const rows: LayoutPlanRow[] = members.map((p) => {
      const mine = grants.filter((g) => g.variantId === p.variantId);
      const measured = mine
        .filter((g) => g.firstReadingAt !== null && g.firstReadingAt.getTime() <= since)
        .map((g) => {
          const use = scale(g.usedInWindow, periodScale);
          const ranOut = g.purchasedBytes > BigInt(0) && scale(g.purchasedBytes, AT_CAP_SHARE) <= g.consumedBytes;
          return { use, atCap: ranOut || use >= scale(p.size, AT_CAP_SHARE) };
        });
      measuredOf.set(p.variantId, measured);
      const sorted = measured.map((m) => m.use).sort(byBigint);
      return {
        variantId: p.variantId,
        sku: p.sku,
        nameKey: p.nameKey,
        size: p.size.toString(),
        active: mine.length,
        measured: measured.length,
        usage: sorted.length
          ? { p25: quantile(sorted, 0.25).toString(), p50: quantile(sorted, 0.5).toString(), p75: quantile(sorted, 0.75).toString(), p90: quantile(sorted, 0.9).toString() }
          : null,
        under: measured.filter((m) => m.use < scale(p.size, UNDER_SHARE)).length,
        atCap: measured.filter((m) => m.atCap).length,
      };
    });

    const suggestions: Reason[] = [];
    members.forEach((p, i) => {
      const row = rows[i];
      if (row.measured < LAYOUT_MIN_MEASURED) return;
      if (row.under / row.measured >= UNDER_USERS_SHARE) {
        const under = (measuredOf.get(p.variantId) ?? []).map((m) => m.use).filter((u) => u < scale(p.size, UNDER_SHARE)).sort(byBigint);
        const size = roundSize(scale(quantile(under, 0.75), SMALLER_HEADROOM));
        const sold = members.some((q) => q.size >= size && q.size < p.size);
        if (size < p.size && !sold) suggestions.push({ code: 'add_smaller', variantId: p.variantId, users: row.under, measured: row.measured, share: share(row.under, row.measured), size: size.toString() });
      }
      if (i === members.length - 1 && row.atCap / row.measured >= AT_CAP_USERS_SHARE) {
        const size = roundSize(scale(p.size, BIGGER_FACTOR));
        suggestions.push({ code: 'add_bigger', variantId: p.variantId, users: row.atCap, measured: row.measured, share: share(row.atCap, row.measured), size: size.toString(), demandCensored: true });
      }
    });
    const familyMeasured = rows.reduce((a, r) => a + r.measured, 0);
    if (familyMeasured >= LAYOUT_MIN_MEASURED) {
      for (const r of rows) if (r.active === 0) suggestions.push({ code: 'no_takers', variantId: r.variantId, users: 0, measured: familyMeasured });
    }
    out.push({ productId, billingMode, durationDays, plans: rows, suggestions });
  }
  out.sort((a, b) => a.productId.localeCompare(b.productId) || (a.durationDays ?? Infinity) - (b.durationDays ?? Infinity));
  return { families: out };
}

/**
 * The reads behind `GET /api/ai/admin/plan-layout`: the plans and the active
 * Grants through `txnet_ai_reader` under the tenant's RLS (invariant 7), the
 * readings from the engine's own `ai.meter_reading` on the app pool.
 */
@Injectable()
export class PlanLayout {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: AiReaderPrisma,
  ) {}

  async report(tenantId: string, now: Date): Promise<{ families: LayoutFamily[] }> {
    const since = new Date(now.getTime() - LAYOUT_WINDOW_DAYS * DAY_MS);
    const theirs = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(
        this.reader,
        async (tx) => {
          const variants = await tx.productVariant.findMany({
            where: { isActive: true, visibility: 'public', billingMode: 'prepaid' },
            select: { id: true, productId: true, sku: true, nameKey: true, billingMode: true, durationDays: true, quotas: true, product: { select: { nameKey: true } } },
          });
          const grants = await tx.grant.findMany({
            where: { status: 'active', variantId: { in: variants.map((v) => v.id) } },
            select: { id: true, variantId: true, purchasedBytes: true, consumedBytes: true },
          });
          return { variants, grants };
        },
        { timeout: 30_000 },
      ),
    );
    const readings = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.$queryRaw<Array<{ grantId: string; used: bigint | null; first: Date }>>(Prisma.sql`
          SELECT "grantId", SUM("delta") FILTER (WHERE "hour" >= ${since}) AS "used", MIN("hour") AS "first"
          FROM ai.meter_reading
          WHERE "tenantId" = ${tenantId}::uuid AND "meterKey" = ${METER_KEYS.vpnTraffic}
          GROUP BY "grantId"`),
      ),
    );
    const read = new Map(readings.map((r) => [r.grantId, r]));

    const plans: LayoutPlan[] = theirs.variants.map((v) => {
      const limit = (v.quotas as Record<string, { limit?: unknown }> | null)?.['traffic_bytes']?.limit;
      const sized = typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0;
      return {
        variantId: v.id,
        productId: v.productId,
        sku: v.sku,
        nameKey: v.nameKey ?? v.product.nameKey,
        billingMode: v.billingMode,
        durationDays: v.durationDays,
        size: sized ? BigInt(limit) : null,
        unlimited: limit === 0,
      };
    });
    const grants: LayoutGrant[] = theirs.grants.map((g) => {
      const r = read.get(g.id);
      return {
        variantId: g.variantId as string,
        usedInWindow: BigInt(r?.used ?? 0),
        firstReadingAt: r?.first ?? null,
        purchasedBytes: g.purchasedBytes,
        consumedBytes: g.consumedBytes,
      };
    });
    return planLayout(plans, grants, now);
  }
}
