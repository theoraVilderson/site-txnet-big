import { Prisma } from '@prisma/client';
import { FORECAST_RATE_DAYS } from '@txnet-backend/shared-core';

import type { CostRow } from '../systems/panel-cost-on';
import { costOn } from '../systems/panel-cost-on';
import { PanelForecast, forecastPanel, monthCostUsd, projectMonth } from './analytics-capacity-forecast';
import type { TabContext } from './analytics-context';
import { Day, addDays, dayOf } from './analytics-days';
import { Amounts, currenciesOf } from './analytics-figures';
import { costAmount, costCurrency, own } from './analytics-margin';
import { MoneyRow, marginCellOf } from './analytics-margin-cells';

export type CapacityPanel = PanelForecast & {
  panelId: string;
  name: string;
  /** The price in effect today, USD; null = no cost set. */
  monthlyCostUsd: string | null;
  /** The whole month at each day's price, USD. */
  projectedCostUsd: string | null;
  /** The month's own net and cost projected to its end (the Profit tab's figures); `null` without a cost set — no cost, no margin. */
  net: Amounts | null;
  cost: Amounts | null;
  margin: Amounts | null;
  marginRate: number | null;
  loss: boolean;
};

export type CapacityTab = { month: Day; today: Day; currencies: string[]; panels: CapacityPanel[] };

type PanelRow = { id: string; name: string; maxClients: number | null };
type DayMoney = MoneyRow & { day: Day };

/** The panels this tenant owns and serves on — the platform's for the platform, a reseller's own for it — the panel filter narrowing them. */
function readPanels(c: TabContext): Promise<PanelRow[]> {
  const mine = c.platform ? Prisma.sql`p."ownershipType" = 'platform'` : Prisma.sql`p."ownershipType" = 'tenant' AND p."tenantId" = public.current_tenant_id()`;
  const one = c.filters.panel ? Prisma.sql`AND p."id" = ${c.filters.panel}::uuid` : Prisma.empty;
  return c.tx.$queryRaw<PanelRow[]>`
    SELECT p."id"::text AS "id", p."name", p."maxClients" FROM network.panel p
    WHERE ${mine} AND p."retiredAt" IS NULL ${one} ORDER BY p."name", p."id"`;
}

/** Rows of one panel. */
const of = <R extends { panelId: string }>(rows: readonly R[], id: string) => rows.filter((r) => r.panelId === id);

/** The rollup's figures for `ids` from `since` (the month's first day, or a week back if earlier) to `today`. */
async function readFigures(tx: Prisma.TransactionClient, ids: string[], since: Day, today: Day) {
  const k = Prisma.sql`k`;
  const traffic = await tx.$queryRaw<{ panelId: string; day: Day; bytes: bigint }[]>`
    SELECT t."panelId"::text AS "panelId", to_char(t."day", 'YYYY-MM-DD') AS "day", t."bytes" FROM billing.analytics_panel_traffic_day t
    WHERE t."tenantId" = public.current_tenant_id() AND t."panelId"::text = ANY(${ids}) AND t."day" >= ${since}::date AND t."day" < ${today}::date`;
  const first = await tx.$queryRaw<{ panelId: string; day: Day }[]>`
    SELECT t."panelId"::text AS "panelId", to_char(MIN(t."day"), 'YYYY-MM-DD') AS "day" FROM billing.analytics_panel_traffic_day t
    WHERE t."tenantId" = public.current_tenant_id() AND t."panelId"::text = ANY(${ids}) GROUP BY 1`;
  const clients = await tx.$queryRaw<{ panelId: string; day: Day; clients: number }[]>`
    SELECT c."panelId"::text AS "panelId", to_char(c."day", 'YYYY-MM-DD') AS "day", c."clients" FROM billing.analytics_panel_clients_day c
    WHERE c."tenantId" = public.current_tenant_id() AND c."panelId"::text = ANY(${ids}) AND c."day" BETWEEN ${addDays(today, -FORECAST_RATE_DAYS)}::date AND ${today}::date`;
  const net = await tx.$queryRaw<(DayMoney & { panelId: string })[]>`
    SELECT s."panelId"::text AS "panelId", s."panelId"::text AS "key", to_char(s."day", 'YYYY-MM-DD') AS "day", s."currencyCode", SUM(s."net") AS "amount"
    FROM billing.analytics_sales_day s
    WHERE s."tenantId" = public.current_tenant_id() AND s."panelId"::text = ANY(${ids}) AND s."day" >= ${since}::date AND s."day" < ${today}::date
    GROUP BY 1, 3, 4`;
  const cost = await tx.$queryRaw<(DayMoney & { panelId: string })[]>`
    SELECT k."panelId"::text AS "panelId", k."panelId"::text AS "key", to_char(k."day", 'YYYY-MM-DD') AS "day", ${costCurrency(k)} AS "currencyCode", SUM(${costAmount(k)}) AS "amount"
    FROM billing.analytics_cost_day k
    WHERE k."tenantId" = public.current_tenant_id() AND ${own(k)} AND k."panelId"::text = ANY(${ids}) AND k."day" >= ${since}::date AND k."day" < ${today}::date
    GROUP BY 1, 3, 4`;
  const prices = await tx.$queryRaw<(CostRow & { panelId: string; monthlyTrafficBytes: bigint | null })[]>`
    SELECT pc."panelId"::text AS "panelId", pc."monthlyCostUsd", pc."monthlyTrafficBytes", pc."effectiveFrom", pc."createdByUserId", pc."createdAt"
    FROM network.panel_cost pc WHERE pc."panelId"::text = ANY(${ids})`;
  return { traffic, first: new Map(first.map((r) => [r.panelId, r.day])), clients, net, cost, prices };
}

/** A projection as the rows `marginCellOf` reads. */
const asRows = (id: string, projected: Map<string, Prisma.Decimal> | null): MoneyRow[] => [...(projected ?? [])].map(([currencyCode, amount]) => ({ key: id, currencyCode, amount }));

/**
 * The Capacity tab (F-1005-a, contract.analytics-tabs.md "Capacity"): every
 * panel the tenant owns, this **UTC month as of today** — the window, the
 * comparison and every filter but the panel do not apply; a forecast has one
 * now. Soonest full first, then by name. Panels are not people: nothing here
 * is hidden from the platform's staff.
 */
export async function capacityOf(c: TabContext, now = new Date()): Promise<CapacityTab> {
  const today = dayOf(now, 'UTC');
  const month = `${today.slice(0, 8)}01`;
  const panels = await readPanels(c);
  const ids = panels.map((p) => p.id);
  const since = [month, addDays(today, -FORECAST_RATE_DAYS)].sort()[0];
  const f = ids.length ? await readFigures(c.tx, ids, since, today) : null;
  const currencies = currenciesOf(c.operating, f ? [...f.net, ...f.cost].map((r) => r.currencyCode) : []);

  const rows = panels.map((p): CapacityPanel => {
    const prices = f ? of(f.prices, p.id) : [];
    const first = f?.first.get(p.id) ?? null;
    const forecast = forecastPanel({
      today,
      traffic: f ? of(f.traffic, p.id) : [],
      firstTrafficDay: first,
      allowanceBytes: costOn(prices, today)?.monthlyTrafficBytes ?? null,
      clients: f ? of(f.clients, p.id) : [],
      maxClients: p.maxClients,
    });
    const monthCost = monthCostUsd(prices, today);
    const price = costOn(prices, today);
    const cell =
      monthCost === null || !f
        ? null
        : marginCellOf(p.id, asRows(p.id, projectMonth(of(f.net, p.id), first, today)), asRows(p.id, projectMonth(of(f.cost, p.id), first, today)), { currencies, operating: c.operating });
    return {
      panelId: p.id,
      name: p.name,
      ...forecast,
      monthlyCostUsd: price?.monthlyCostUsd.toFixed(2) ?? null,
      projectedCostUsd: monthCost?.toFixed(2) ?? null,
      net: cell?.net ?? null,
      cost: cell?.cost ?? null,
      margin: cell?.margin ?? null,
      marginRate: cell?.marginRate ?? null,
      loss: cell?.loss ?? false,
    };
  });
  const order = (p: CapacityPanel) => p.daysUntilFull ?? Number.POSITIVE_INFINITY;
  return { month, today, currencies, panels: rows.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)) };
}
