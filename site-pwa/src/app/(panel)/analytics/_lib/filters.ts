import { ANALYTICS_COMPARES, ANALYTICS_TABS, FULFILMENT_KINDS, type AnalyticsCalendar, type AnalyticsCompare, type AnalyticsQuery, type AnalyticsTab, type FulfilmentKind } from "@/lib/billing/analytics";
import { DAY_KEY_LOCALE } from "../../_lib/datetime";
import { numberLocale } from "../../_lib/digits";

/**
 * The filter bar's state (F-1001-d, panel-web `contract.analytics.md` "Filter
 * bar"): all of it in the URL, so a view is a link that survives a reload. A
 * value the page does not know falls back to its default rather than failing.
 */

/** The range presets, in the bar's order; `custom` reads `from` and `to`. */
export const RANGE_PRESETS = ["today", "7d", "30d", "thisMonth", "lastMonth", "90d", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface AnalyticsFilters {
  tab: AnalyticsTab;
  range: RangePreset;
  /** Only with `custom`. */
  from: string | null;
  to: string | null;
  compare: AnalyticsCompare;
  product: string | null;
  panel: string | null;
  /** The product kind (ADR-0148); offered only when the window holds two. */
  fulfilment: FulfilmentKind | null;
  /** Which currency the figures are drawn in when the window holds several; null = the operating one. */
  currency: string | null;
}

export const DEFAULT_FILTERS: AnalyticsFilters = {
  tab: "overview",
  range: "30d",
  from: null,
  to: null,
  compare: "previous",
  product: null,
  panel: null,
  fulfilment: null,
  currency: null,
};

/** Days back from today, today included, per rolling preset; the default's when a month or custom range lacks its dates. */
const ROLLING_DAYS: Partial<Record<RangePreset, number>> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };
const DEFAULT_DAYS = 30;

/** The `Intl` calendar each of billing's calendars is. */
const INTL_CALENDAR: Record<AnalyticsCalendar, string> = { jalali: "persian", gregorian: "gregory" };

/** The longest month in any calendar: how far back a month's 1st can be. */
const MAX_MONTH_DAYS = 31;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

const isDay = (v: string | null): v is string => v !== null && DAY_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const oneOf = <T extends string>(set: readonly T[], v: string | null, fallback: T): T => (v !== null && (set as readonly string[]).includes(v) ? (v as T) : fallback);
const matching = (re: RegExp, v: string | null) => (v !== null && re.test(v) ? v : null);
const kindOf = (v: string | null): FulfilmentKind | null => FULFILMENT_KINDS.find((k) => k === v) ?? null;

/** The filters a URL holds; anything unreadable is the default. */
export function filtersOf(params: { get(key: string): string | null }): AnalyticsFilters {
  const from = params.get("from");
  const to = params.get("to");
  const custom = params.get("range") === "custom" && isDay(from) && isDay(to) && from <= to;
  const range = custom ? "custom" : oneOf(RANGE_PRESETS.filter((r) => r !== "custom"), params.get("range"), DEFAULT_FILTERS.range);
  return {
    tab: oneOf(ANALYTICS_TABS, params.get("tab"), DEFAULT_FILTERS.tab),
    range,
    from: custom ? from : null,
    to: custom ? to : null,
    compare: oneOf(ANALYTICS_COMPARES, params.get("compare"), DEFAULT_FILTERS.compare),
    product: matching(UUID_RE, params.get("product")),
    panel: matching(UUID_RE, params.get("panel")),
    fulfilment: kindOf(params.get("fulfilment")),
    currency: matching(CURRENCY_RE, params.get("currency")),
  };
}

/** The query string for `f`, defaults left off — the bare page is the default view. */
export function searchOf(f: AnalyticsFilters): string {
  const out = new URLSearchParams();
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof AnalyticsFilters)[]) {
    const value = f[key];
    if (value !== null && value !== DEFAULT_FILTERS[key]) out.set(key, value);
  }
  return out.toString();
}

/** How many filters differ from the default — the phone's Filters button shows it. */
export function activeFilterCount(f: AnalyticsFilters): number {
  return (["range", "compare", "product", "panel", "fulfilment"] as const).filter((key) => f[key] !== DEFAULT_FILTERS[key]).length;
}

/** The calendar of the reader's language, as `Intl` resolves it — no table of languages here (C-17). */
export function calendarOf(lang: string): AnalyticsCalendar {
  return new Intl.DateTimeFormat(numberLocale(lang)).resolvedOptions().calendar === INTL_CALENDAR.jalali ? "jalali" : "gregorian";
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The 1st of the month `day` falls in, in `calendar`. */
function monthStart(day: string, calendar: AnalyticsCalendar): string {
  const dayOfMonth = new Intl.DateTimeFormat(DAY_KEY_LOCALE, { day: "numeric", calendar: INTL_CALENDAR[calendar], timeZone: "UTC" });
  let at = day;
  for (let i = 0; i < MAX_MONTH_DAYS && dayOfMonth.format(new Date(`${at}T00:00:00Z`)) !== "1"; i++) at = addDays(at, -1);
  return at;
}

/** The window the filters name, ending `today` — the viewer's day; the figures are cut on the tenant's. */
export function windowOf(f: AnalyticsFilters, today: string, calendar: AnalyticsCalendar): { from: string; to: string } {
  if (f.range === "custom" && f.from && f.to) return { from: f.from, to: f.to };
  if (f.range === "thisMonth") return { from: monthStart(today, calendar), to: today };
  if (f.range === "lastMonth") {
    const end = addDays(monthStart(today, calendar), -1);
    return { from: monthStart(end, calendar), to: end };
  }
  return { from: addDays(today, 1 - (ROLLING_DAYS[f.range] ?? DEFAULT_DAYS)), to: today };
}

/** What billing is asked for these filters. */
export function queryOf(f: AnalyticsFilters, today: string, calendar: AnalyticsCalendar): AnalyticsQuery {
  return { ...windowOf(f, today, calendar), compare: f.compare, calendar, product: f.product ?? undefined, panel: f.panel ?? undefined, fulfilment: f.fulfilment ?? undefined };
}
