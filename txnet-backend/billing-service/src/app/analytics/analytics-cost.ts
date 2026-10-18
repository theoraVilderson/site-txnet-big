import { Prisma } from '@prisma/client';
import { roundRate, splitWhole } from '@txnet-backend/shared-core';

import { CostRow, costOn } from '../systems/panel-cost-on';
import { Day, addDays } from './analytics-days';

/**
 * Cost attribution (F-1002-b, billing/contract.analytics.md "Cost and margin")
 * — the arithmetic, pure, so the rollup's reads and writes stay plain SQL and
 * the rules are held by a spec. Every result is a row of `analytics_cost_day`.
 */

/**
 * What a cost row is: a panel's day split by bytes, a panel's day with no
 * traffic, what a reseller pays the platform per use, its subscription — and
 * the tenant's own costs (ADR-0151): a sale's variant cost, a meter's use.
 */
export type CostKind = 'panel' | 'idle' | 'wholesale' | 'subscription' | 'sale' | 'usage';

export type CostDayRow = {
  day: Day;
  kind: CostKind;
  panelId: string | null;
  /** The tenant whose Grant used the bytes (a panel's cost, on the platform's rows); null otherwise. */
  servedTenantId: string | null;
  productId: string | null;
  /** The tenant's own user: a reseller's people are never on the platform's rows (ADR-0104), only on its own. */
  userId: string | null;
  currencyCode: string;
  cost: Prisma.Decimal;
  bytes: bigint;
};

/** A cost is kept to six places — a unit-price scale, where precision lives (ADR-0153 point 5) — so a split rounds below a cent and a month's sum stays whole. */
const COST_PLACES = 6;
/** Panels are bought in dollars (network `contract.panel-cost.md` rule 5). */
const PANEL_CURRENCY = 'USD';

const ZERO = new Prisma.Decimal(0);

const daysInMonthOf = (day: Day) => {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};


/** One panel's use on one day: the bytes a Grant of `servedTenantId` used on it. */
export type PanelUse = { day: Day; panelId: string; servedTenantId: string; productId: string | null; userId: string | null; bytes: bigint };

/**
 * A panel's month over its days, each day split over the Grants that used it
 * by bytes; a day with no bytes keeps its whole cost on the panel as `idle`.
 * A day before the panel's first price writes nothing — "no cost set" is read
 * from `network.panel_cost` itself, never stored as 0. `prices` are one
 * panel's or many; each day is priced by `costOn`.
 */
export function attributePanelCosts<P extends CostRow & { panelId: string }>(days: readonly Day[], prices: readonly P[], use: readonly PanelUse[]): CostDayRow[] {
  const rows: CostDayRow[] = [];
  for (const panelId of [...new Set(prices.map((p) => p.panelId))].sort()) {
    const own = prices.filter((p) => p.panelId === panelId);
    for (const day of days) {
      const price = costOn(own, day);
      if (!price) continue;
      const daily = roundRate(price.monthlyCostUsd.div(daysInMonthOf(day)), COST_PLACES);
      const used = use.filter((u) => u.panelId === panelId && u.day === day && u.bytes > BigInt(0));
      if (used.length === 0) {
        rows.push({ day, kind: 'idle', panelId, servedTenantId: null, productId: null, userId: null, currencyCode: PANEL_CURRENCY, cost: daily, bytes: BigInt(0) });
        continue;
      }
      // Split at six places, the shares summing to the day exactly (ADR-0153 point 4).
      const shares = splitWhole(daily, used.map((u) => u.bytes), COST_PLACES);
      used.forEach((u, i) =>
        rows.push({ day, kind: 'panel', panelId, servedTenantId: u.servedTenantId, productId: u.productId, userId: u.userId, currencyCode: PANEL_CURRENCY, cost: shares[i], bytes: u.bytes }),
      );
    }
  }
  return rows;
}

/** Who a cost is: the product, panel and user of the Grant it was paid for. */
export type CostOwner = { productId: string | null; panelId: string | null; userId: string | null };

/**
 * A reseller's ledger row with the platform, signed: a charge positive, a
 * refund negative; `grant` when the row names a Grant (ADR-0151 (4)).
 */
export type ResellerCharge = { day: Day; currencyCode: string; amount: Prisma.Decimal; grant?: CostOwner | null };

/** A reseller's own use of the platform's panels on one day, per product, panel and user. */
export type WholesaleUse = { day: Day; productId: string | null; panelId: string | null; userId: string | null; bytes: bigint };

/**
 * What a reseller pays the platform per use (`metered_usage_charge` net of
 * `metered_usage_refund`), a day at a time, split over its products, panels
 * and users by the bytes its Grants used that day (F-1001-l: its own people,
 * so a user's margin and F-1003 hold for a reseller too). A day with no bytes
 * is unallocated (product null) — paid, but for nothing this day shows.
 */
export function attributeWholesale(all: readonly ResellerCharge[], use: readonly WholesaleUse[]): CostDayRow[] {
  // A charge that names a Grant is that Grant's, whole (ADR-0151 (4)); only the rest is split.
  const rows: CostDayRow[] = sumByCell(
    all.filter((c) => c.grant).map((c) => ({ ...(c.grant as CostOwner), day: c.day, kind: 'wholesale' as const, currencyCode: c.currencyCode, cost: c.amount })),
  );
  const charges = all.filter((c) => !c.grant);
  const keys = [...new Set(charges.map((c) => `${c.day}|${c.currencyCode}`))].sort();
  for (const key of keys) {
    const [day, currencyCode] = key.split('|');
    const net = charges.filter((c) => c.day === day && c.currencyCode === currencyCode).reduce((sum, c) => sum.plus(c.amount), ZERO);
    if (net.isZero()) continue;
    const used = use.filter((u) => u.day === day && u.bytes > BigInt(0));
    const row = { day, kind: 'wholesale' as const, servedTenantId: null, currencyCode };
    if (used.length === 0) {
      rows.push({ ...row, productId: null, panelId: null, userId: null, cost: net, bytes: BigInt(0) });
      continue;
    }
    const shares = splitWhole(net, used.map((u) => u.bytes), COST_PLACES);
    used.forEach((u, i) => rows.push({ ...row, productId: u.productId, panelId: u.panelId, userId: u.userId, cost: shares[i], bytes: u.bytes }));
  }
  return rows;
}

/**
 * Each `subscription_charge` spread evenly over its period: from its day to
 * the day before the next charge, the last one to the subscription's current
 * period end — the periods as they were actually charged, so a change of
 * billing model needs no arithmetic here. Only days inside `window` are
 * answered. Unallocated: a fixed cost belongs to no product.
 */
export function spreadSubscriptions(charges: readonly ResellerCharge[], how: { periodEnd: Day | null; window: { from: Day; to: Day } }): CostDayRow[] {
  const sorted = [...charges].sort((a, b) => a.day.localeCompare(b.day));
  const rows: CostDayRow[] = [];
  sorted.forEach((charge, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1].day : how.periodEnd;
    if (!end || end <= charge.day) return;
    const days: Day[] = [];
    for (let day = charge.day; day < end; day = addDays(day, 1)) days.push(day);
    const daily = roundRate(charge.amount.div(days.length), COST_PLACES);
    for (const day of days) {
      if (day < how.window.from || day > how.window.to) continue;
      rows.push({ day, kind: 'subscription', panelId: null, servedTenantId: null, productId: null, userId: null, currencyCode: charge.currencyCode, cost: daily, bytes: BigInt(0) });
    }
  });
  return rows;
}

/** One cost row per cell (day, kind, product, panel, user, currency), the costs summed and kept to six places — a 0 kept: it says "costs nothing" (ADR-0151 (5)). */
function sumByCell(parts: readonly (CostOwner & { day: Day; kind: CostKind; currencyCode: string; cost: Prisma.Decimal })[]): CostDayRow[] {
  const cells = new Map<string, CostDayRow>();
  for (const p of parts) {
    const key = [p.day, p.kind, p.productId, p.panelId, p.userId, p.currencyCode].join('|');
    const row = cells.get(key) ?? { day: p.day, kind: p.kind, panelId: p.panelId, servedTenantId: null, productId: p.productId, userId: p.userId, currencyCode: p.currencyCode, cost: ZERO, bytes: BigInt(0) };
    cells.set(key, { ...row, cost: row.cost.plus(p.cost) });
  }
  return [...cells.values()].map((r) => ({ ...r, cost: roundRate(r.cost, COST_PLACES) }));
}

/** A sale or the refund that undoes it, priced at the variant's cost in effect when it was sold. */
export type SaleCost = CostOwner & { day: Day; currencyCode: string; cost: Prisma.Decimal; sale: boolean };
/** A Grant's use of a meter on a day, and the meter's unit cost in effect then. */
export type UsageCost = CostOwner & { day: Day; currencyCode: string; quantity: bigint; unitSize: bigint; unitCost: Prisma.Decimal };

/**
 * The tenant's own costs (F-1002-e, ADR-0151 (1)): each sale its variant's
 * cost per sale (a refund the same back), each use its quantity over the
 * meter's unit size times the unit cost — summed per cell.
 */
export function ownCosts(sales: readonly SaleCost[], usage: readonly UsageCost[]): CostDayRow[] {
  return sumByCell([
    ...sales.map((s) => ({ ...s, kind: 'sale' as const, cost: s.sale ? s.cost : s.cost.neg() })),
    ...usage.map((u) => ({ ...u, kind: 'usage' as const, cost: u.unitCost.mul(u.quantity.toString()).div(u.unitSize.toString()) })),
  ]);
}
