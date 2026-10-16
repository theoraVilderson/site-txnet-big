import { FulfilmentKind, MeterUnit, Prisma } from '@prisma/client';

import type { Window } from './analytics-read';

/**
 * What the page names a product or panel by (F-1001-d): a product's catalog
 * `nameKey` — the words are the published `catalog` namespace, in the reader's
 * language — and a panel's own name. Ids only, never a person (ADR-0104).
 */
export type AnalyticsNames = {
  products: { id: string; nameKey: string }[];
  panels: { id: string; name: string }[];
  /** Each meter used in the window, in the unit its figures are written in, named by its `catalog` key (F-1001-n). */
  meters: { key: string; unit: MeterUnit; nameKey: string }[];
  /** The product kinds in the window — the kind filter is a choice only when there are two (ADR-0148 (3)). */
  kinds: FulfilmentKind[];
};

/**
 * Every product and panel with a row in the tenant's rollup over `w`, named —
 * the filter bar's choices and every chart's labels. Unfiltered on purpose: a
 * filter that is on must stay among the choices. Ids come from the tenant's
 * own rollup rows (RLS); `network.panel` has no RLS, so it is read by those ids
 * alone, name only, as `moveTargets` reads it.
 */
export async function namesOf(tx: Prisma.TransactionClient, w: Window): Promise<AnalyticsNames> {
  const rows = await tx.$queryRaw<{ productId: string | null; panelId: string | null }[]>`
    SELECT DISTINCT s."productId", s."panelId" FROM billing.analytics_sales_day s
    WHERE s."tenantId" = public.current_tenant_id() AND s."day" BETWEEN ${w.from}::date AND ${w.to}::date
    UNION
    SELECT DISTINCT k."productId", k."panelId" FROM billing.analytics_stock_day k
    WHERE k."tenantId" = public.current_tenant_id() AND k."day" BETWEEN ${w.from}::date AND ${w.to}::date
    UNION
    SELECT DISTINCT e."productId", e."panelId" FROM billing.analytics_meter_day e
    WHERE e."tenantId" = public.current_tenant_id() AND e."day" BETWEEN ${w.from}::date AND ${w.to}::date`;
  const meterKeys = await tx.$queryRaw<{ meterKey: string }[]>`
    SELECT DISTINCT e."meterKey" FROM billing.analytics_meter_day e
    WHERE e."tenantId" = public.current_tenant_id() AND e."day" BETWEEN ${w.from}::date AND ${w.to}::date`;
  const ids = (pick: (r: (typeof rows)[number]) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))];
  const productIds = ids((r) => r.productId);
  const panelIds = ids((r) => r.panelId);
  // One transaction runs one query at a time, so these are sequential, not parallel.
  // The catalog's own order (creation) is what keeps a product's colour slot (panel-web rule 3).
  const found = productIds.length ? await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, nameKey: true, fulfilmentKind: true }, orderBy: { createdAt: 'asc' } }) : [];
  const panels = panelIds.length ? await tx.panel.findMany({ where: { id: { in: panelIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [];
  // `catalog.meter` is the platform's one list (no tenant): read by the keys the tenant's own rows name.
  const meters = meterKeys.length ? await tx.meter.findMany({ where: { key: { in: meterKeys.map((m) => m.meterKey) } }, select: { key: true, unit: true, nameKey: true }, orderBy: { key: 'asc' } }) : [];
  return {
    products: found.map(({ id, nameKey }) => ({ id, nameKey })),
    panels,
    meters,
    kinds: Object.values(FulfilmentKind).filter((kind) => found.some((p) => p.fulfilmentKind === kind)),
  };
}
