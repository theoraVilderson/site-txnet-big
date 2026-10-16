// A tenant's analytics by the path's tenant (F-1001-b, billing/contract.analytics.md "Read routes").
import type { ApiFile } from "../api-request";
import { call } from "./client";

/** The tabs billing answers today; a later row adds its own. */
export const ANALYTICS_TABS = ["overview"] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

/** What a window is compared with — billing's `COMPARES`. */
export const ANALYTICS_COMPARES = ["previous", "year", "none"] as const;
export type AnalyticsCompare = (typeof ANALYTICS_COMPARES)[number];

/** The calendar weeks and months are cut in — billing's `CALENDARS`, chosen by the reader's language. */
export type AnalyticsCalendar = "jalali" | "gregorian";

export type Granularity = "day" | "week" | "month";

/** A tab's query as billing reads it: tenant days, both included. */
export interface AnalyticsQuery {
  from: string;
  to: string;
  compare: AnalyticsCompare;
  calendar: AnalyticsCalendar;
  product?: string;
  panel?: string;
}

/** Money per currency, as decimal strings (C-02): `{ "USD": "41.25" }`. */
export type Amounts = Record<string, string>;
/** A ratio, `new` from zero, `null` with nothing compared. */
export type Delta = number | "new" | null;
export type CountKpi = { value: number; previous: number | null; delta: Delta };
export type MoneyKpi = { value: Amounts; previous: Amounts | null; delta: Record<string, Delta> };

/** What a cell under 5 people says instead of its figures, to the platform's staff (ADR-0104). */
export const FEWER_THAN_5 = "fewer_than_5";

export interface AnalyticsSeries {
  salesPackage: (Amounts | null)[];
  salesUsage: (Amounts | null)[];
  topUps: (Amounts | null)[];
  orders: (number | null)[];
  newBuyers: (number | null)[];
  returningBuyers: (number | null)[];
}

export type ProductCell =
  | { productId: string | null; net: Amounts; orders: number; buyers: number; share: number | null }
  | { productId: string | null; people: typeof FEWER_THAN_5 };

/** The overview's KPIs by kind: money per currency, or a count. */
type MoneyKpiName = "net" | "gross" | "refunds" | "topUps" | "aov" | "arpu";
type CountKpiName = "orders" | "buyers" | "newBuyers" | "returningBuyers" | "activeGrants";

export interface AnalyticsOverview {
  currencies: string[];
  kpis: Record<MoneyKpiName, MoneyKpi> &
    Record<CountKpiName, CountKpi> & {
      /** `null` until F-1001-f answers it. */
      renewal: { rate: number | null; renewed: number; lapsed: number; pending: number } | null;
      bytesUsed: { value: string; previous: string | null; delta: Delta };
    };
  series: AnalyticsSeries;
  previousSeries: AnalyticsSeries | null;
  byProduct: { top: ProductCell[]; other: { net: Amounts; orders: number; share: number | null } | null };
  calendar: { day: string; net: Amounts | null }[];
}

/** Product names are catalog keys (the published `catalog` namespace); a panel's is its own. */
export interface AnalyticsNames {
  products: { id: string; nameKey: string }[];
  panels: { id: string; name: string }[];
}

type Head = { tab: AnalyticsTab; query: AnalyticsQuery; refreshedAt: string | null };

/** Every tab's answer: nothing but its head while a rebuild runs (principle 5). */
export type AnalyticsAnswer<Body> =
  | (Head & { rebuilding: true })
  | (Head & { rebuilding: false; granularity: Granularity; buckets: string[]; suppressed: boolean; names: AnalyticsNames } & Body);

/** The body each tab answers. */
export interface AnalyticsBodies {
  overview: AnalyticsOverview;
}

const tabPath = (tenantId: string, tab: AnalyticsTab) => `/tenants/${encodeURIComponent(tenantId)}/analytics/${tab}`;

/** `?from=…&to=…` with the empty filters left off: a blank `product` would fail billing's uuid check. */
export function analyticsSearch(q: AnalyticsQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  return params.toString();
}

/** One tab of the path's tenant. No permission is judged here: billing's door is `analytics.read`. */
export function readAnalytics<T extends AnalyticsTab>(tenantId: string, tab: T, q: AnalyticsQuery): Promise<AnalyticsAnswer<AnalyticsBodies[T]>> {
  return call<AnalyticsAnswer<AnalyticsBodies[T]>>(`${tabPath(tenantId, tab)}?${analyticsSearch(q)}`);
}

/** The formats billing's export writes — its `EXPORT_FORMATS` (F-1007-a). */
export const ANALYTICS_EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type AnalyticsExportFormat = (typeof ANALYTICS_EXPORT_FORMATS)[number];

/** The same tab and filters as a file: the same door, scope and under-5 rule as the page. */
export function exportAnalytics(tenantId: string, tab: AnalyticsTab, q: AnalyticsQuery, format: AnalyticsExportFormat): Promise<ApiFile> {
  return call<ApiFile>(`${tabPath(tenantId, tab)}?${analyticsSearch(q)}&format=${format}`);
}
