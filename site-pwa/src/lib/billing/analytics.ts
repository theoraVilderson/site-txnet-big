// A tenant's analytics by the path's tenant (F-1001-b, billing/contract.analytics.md "Read routes").
import type { ApiFile } from "../api-request";
import { call } from "./client";

/** The tabs billing answers today, in the page's order; a later row adds its own. */
export const ANALYTICS_TABS = ["overview", "sales", "catalog"] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

/** What a window is compared with — billing's `COMPARES`. */
export const ANALYTICS_COMPARES = ["previous", "year", "none"] as const;
export type AnalyticsCompare = (typeof ANALYTICS_COMPARES)[number];

/** The calendar weeks and months are cut in — billing's `CALENDARS`, chosen by the reader's language. */
export type AnalyticsCalendar = "jalali" | "gregorian";

export type Granularity = "day" | "week" | "month";

/** A product's kind — catalog's `FulfilmentKind`, fixed when the product is created (ADR-0148). */
export const FULFILMENT_KINDS = ["network_access", "external_order", "feature_access", "wallet_topup"] as const;
export type FulfilmentKind = (typeof FULFILMENT_KINDS)[number];

/** The unit a meter's figures are in — catalog's `MeterUnit`. */
export const METER_UNITS = ["bytes", "count", "seconds", "tokens"] as const;
export type MeterUnit = (typeof METER_UNITS)[number];

/** A tab's query as billing reads it: tenant days, both included. */
export interface AnalyticsQuery {
  from: string;
  to: string;
  compare: AnalyticsCompare;
  calendar: AnalyticsCalendar;
  product?: string;
  panel?: string;
  fulfilment?: FulfilmentKind;
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

/** The KPIs the overview answers; an insight names one of them. */
export const OVERVIEW_KPIS = ["net", "gross", "refunds", "topUps", "aov", "arpu", "orders", "buyers", "newBuyers", "returningBuyers", "activeGrants", "bytesUsed"] as const;
export type OverviewKpi = (typeof OVERVIEW_KPIS)[number];

/**
 * A "what changed" line (F-1001-j): `key` names the sentence, the panel's
 * locale holds its words. Money is the operating currency's, a decimal string.
 */
export type AnalyticsInsight =
  | { key: "kpiMove"; params: { kpi: string; delta: number; currency: string | null } }
  | { key: "productDrove"; params: { productId: string | null; change: string; currency: string } }
  | { key: "unusualDay"; params: { day: string; net: string; mean: string; currency: string } };

/** One meter's use (F-1001-n): integers as decimal strings, in the meter's unit; never added to another meter. */
export interface AnalyticsUsageCard {
  meterKey: string;
  total: string;
  previous: string | null;
  delta: Delta;
  /** Aligned with `buckets`; a bucket hidden from the platform's staff is null. */
  series: (string | null)[];
}

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
  /** Up to three, in billing's order (F-1001-j). */
  insights: AnalyticsInsight[];
  /** One per meter used in either window (F-1001-n). */
  usage: AnalyticsUsageCard[];
}

/** Top-ups through one gateway kind — its provider's name, shown as it is. */
export interface GatewayCell {
  gatewayKind: string | null;
  started: number;
  settled: number;
  failed: number;
  successRate: number | null;
  settledAmount: Amounts;
}

/** The Sales tab (billing `sales`, F-1001-b). */
export interface AnalyticsSales {
  currencies: string[];
  series: AnalyticsSeries;
  previousSeries: AnalyticsSeries | null;
  /** `byKind` is null to the platform's staff on a reseller: no payer per gateway to judge a cell by (ADR-0104). */
  payments: { started: number; settled: number; failed: number; successRate: number | null; byKind: GatewayCell[] | null };
  refunds: MoneyKpi;
  discounts: MoneyKpi;
  giftsCredited: MoneyKpi;
  refundsByProduct: ({ productId: string | null; refunds: Amounts } | { productId: string | null; people: typeof FEWER_THAN_5 })[];
}

/** One product or panel row of the Products and panels tab, or one hidden from the platform's staff. */
export type CatalogCell =
  | { id: string | null; net: Amounts; orders: number; buyers: number; bytesSold: string; bytesUsed: string; share: number | null; sparkline: Amounts[] }
  | { id: string | null; people: typeof FEWER_THAN_5 };

/** The Products and panels tab (billing `catalog`, F-1001-b). */
export interface AnalyticsCatalog {
  currencies: string[];
  products: CatalogCell[];
  panels: CatalogCell[];
}

/** Product names are catalog keys (the published `catalog` namespace); a panel's is its own. */
export interface AnalyticsNames {
  products: { id: string; nameKey: string }[];
  panels: { id: string; name: string }[];
  /** Each meter used in the window, its unit and its `catalog` name key (F-1001-n). */
  meters: { key: string; unit: MeterUnit; nameKey: string }[];
  /** The product kinds in the window; the kind filter is a choice only with two. */
  kinds: FulfilmentKind[];
}

type Head = { tab: AnalyticsTab; query: AnalyticsQuery; refreshedAt: string | null };

/** Every tab's answer: nothing but its head while a rebuild runs (principle 5). */
export type AnalyticsAnswer<Body> =
  | (Head & { rebuilding: true })
  | (Head & { rebuilding: false; granularity: Granularity; buckets: string[]; suppressed: boolean; names: AnalyticsNames } & Body);

/** The body each tab answers. */
export interface AnalyticsBodies {
  overview: AnalyticsOverview;
  sales: AnalyticsSales;
  catalog: AnalyticsCatalog;
}

/** One tab's answer, its `tab` the tab asked: over the union of tabs, a union `tab` narrows. */
export type AnalyticsTabAnswer<T extends AnalyticsTab> = T extends AnalyticsTab ? AnalyticsAnswer<AnalyticsBodies[T]> & { tab: T } : never;

const tabPath = (tenantId: string, tab: AnalyticsTab) => `/tenants/${encodeURIComponent(tenantId)}/analytics/${tab}`;

/** `?from=…&to=…` with the empty filters left off: a blank `product` would fail billing's uuid check. */
export function analyticsSearch(q: AnalyticsQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  return params.toString();
}

/** One tab of the path's tenant. No permission is judged here: billing's door is `analytics.read`. */
export function readAnalytics<T extends AnalyticsTab>(tenantId: string, tab: T, q: AnalyticsQuery): Promise<AnalyticsTabAnswer<T>> {
  return call<AnalyticsTabAnswer<T>>(`${tabPath(tenantId, tab)}?${analyticsSearch(q)}`);
}

/** The formats billing's export writes — its `EXPORT_FORMATS` (F-1007-a). */
export const ANALYTICS_EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type AnalyticsExportFormat = (typeof ANALYTICS_EXPORT_FORMATS)[number];

/** The same tab and filters as a file: the same door, scope and under-5 rule as the page. */
export function exportAnalytics(tenantId: string, tab: AnalyticsTab, q: AnalyticsQuery, format: AnalyticsExportFormat): Promise<ApiFile> {
  return call<ApiFile>(`${tabPath(tenantId, tab)}?${analyticsSearch(q)}&format=${format}`);
}
