/**
 * The financial page's state (F-093-d), which is its URL.
 *
 * Everything the page shows is derived from the query string: which list is
 * open, which page of it, and what narrows it. That is deliberate and it is
 * the one thing legacy got right — a filtered page is a link a user can keep,
 * reload and send to support. What legacy did *not* have is this file: it
 * built the query inline in `AdvancedFilter` and parsed it again inside a
 * server action, and the two spellings drifted.
 *
 * Two rules live here and are covered by `filters.test.ts`:
 *
 * 1. **A day is not an instant.** The picker answers a Gregorian `YYYY-MM-DD`
 *    whichever calendar it drew (`contract.kit.md` rule 5), and `billing` takes
 *    ISO-8601 instants (`domains/billing/contract.history.md`). Resolving the
 *    day into the moment it began and ended is the panel's job, because the
 *    panel is the only side that knows the viewer's zone.
 * 2. **The two lists never share a query.** The ledger's filters and the
 *    payments' filters are built separately, so neither can reach the other's
 *    route.
 */

/** Which of the two lists is open. They are separate lists, not one table with a flag. */
export type FinancialTab = "ledger" | "payments";

/**
 * `WalletReasonType`, mirrored. Values only — the enum lives in the Prisma
 * schema and crosses to this app as query strings, not as a shared type.
 * Declaration order is the order `WalletHistoryService` answers a filter in.
 */
export const REASON_TYPES = [
  "payment_gateway",
  "coupon_redemption",
  "traffic_consumption",
  "admin_manual_adjust",
  "affiliate_commission",
  "sub_account_charge",
  "wallet_transfer_in",
  "wallet_transfer_out",
  "reseller_purchase",
  "traffic_refund",
  "product_purchase",
] as const;
export type ReasonType = (typeof REASON_TYPES)[number];

/** `LedgerDirection`: money into the wallet, money out of it. */
export const DIRECTIONS = ["credit", "debit"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** `PaymentStatus`. Only `success` has a ledger row; the rest moved no money. */
export const PAYMENT_STATUSES = ["pending", "success", "failed", "expired"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The page size both lists ask for. The service defaults to the same number
 * when none is sent, but the table renders a fixed number of skeleton rows and
 * the pager prints "showing 11–20 of 94", so the page has to know it rather
 * than infer it from an answer that has not arrived.
 */
export const DEFAULT_PAGE_SIZE = 10;

export interface FinancialFilters {
  tab: FinancialTab;
  /** 1-based. */
  page: number;
  /** Matched against the translated reason-type labels, ledger only. */
  search: string;
  types: ReasonType[];
  direction: Direction | null;
  statuses: PaymentStatus[];
  /** A Gregorian `YYYY-MM-DD` as the picker answered it, or null. Never an instant. */
  from: string | null;
  to: string | null;
}

export const EMPTY_FILTERS: FinancialFilters = {
  tab: "ledger",
  page: 1,
  search: "",
  types: [],
  direction: null,
  statuses: [],
  from: null,
  to: null,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The moment a calendar day began, where this browser is.
 *
 * `new Date("2026-09-12T00:00:00")` is local time by the language spec, while
 * `new Date("2026-09-12")` is UTC — the difference is one character and a
 * whole day's worth of rows at the edges, so the time part is never omitted.
 */
export function startOfDayInstant(date: string): string {
  return new Date(`${date}T00:00:00.000`).toISOString();
}

/**
 * The last moment of that day. Not the next midnight: `to` is inclusive on the
 * service side (`lte`), so midnight would pull in a transaction stamped
 * 00:00:00 on the day *after* the one the user picked.
 */
export function endOfDayInstant(date: string): string {
  return new Date(`${date}T23:59:59.999`).toISOString();
}

/**
 * Moving to the other list.
 *
 * The date range carries over, because "what happened in Shahrivar" is the
 * same question of either list and re-picking it would be the first thing a
 * user did anyway. The other list's own filters do not: a reason type means
 * nothing to a payment attempt and a status means nothing to a ledger row, and
 * leaving them set would light the filter dot over a list they cannot narrow.
 * Always page 1 — page 4 of one list is not page 4 of the other.
 */
export function forTab(f: FinancialFilters, tab: FinancialTab): FinancialFilters {
  return {
    ...EMPTY_FILTERS,
    tab,
    from: f.from,
    to: f.to,
  };
}

/** Any filter that narrows a list — what the filter button's dot reports. The page and the tab are not filters. */
export function hasNarrowingFilter(f: FinancialFilters): boolean {
  return (
    f.search.trim() !== "" ||
    f.types.length > 0 ||
    f.direction !== null ||
    f.statuses.length > 0 ||
    f.from !== null ||
    f.to !== null
  );
}

/** Add the range both routes share, if either end was picked. */
function appendRange(q: URLSearchParams, f: FinancialFilters): void {
  if (f.from) q.set("from", startOfDayInstant(f.from));
  if (f.to) q.set("to", endOfDayInstant(f.to));
}

function appendPaging(q: URLSearchParams, page: number): void {
  q.set("page", String(page));
  q.set("pageSize", String(DEFAULT_PAGE_SIZE));
}

/**
 * `GET /wallet/history`'s query. An empty `search` is left out rather than sent
 * blank: it would reach `foldedSearch` as a term, and a term matching no label
 * answers an empty page instead of the whole ledger.
 */
export function ledgerQuery(f: FinancialFilters): string {
  const q = new URLSearchParams();
  appendPaging(q, f.page);
  for (const type of f.types) q.append("types", type);
  if (f.direction) q.set("direction", f.direction);
  const search = f.search.trim();
  if (search) q.set("search", search);
  appendRange(q, f);
  return q.toString();
}

/** `GET /wallet/payments`'s query. It carries no `search` and no `types`: a payment attempt has neither. */
export function paymentsQuery(f: FinancialFilters): string {
  const q = new URLSearchParams();
  appendPaging(q, f.page);
  for (const status of f.statuses) q.append("statuses", status);
  appendRange(q, f);
  return q.toString();
}

const oneOf = <T extends string>(allowed: readonly T[], value: string | null): T | null =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const manyOf = <T extends string>(allowed: readonly T[], values: string[]): T[] =>
  values.filter((v): v is T => (allowed as readonly string[]).includes(v));

function readPage(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function readDate(raw: string | null): string | null {
  return raw !== null && DATE.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00.000`)) ? raw : null;
}

/**
 * The URL back into state. Anything the API would refuse is dropped here
 * rather than forwarded: the query string is user-editable, and a hand-typed
 * `direction=sideways` should show the unfiltered list, not a 400 about a
 * parameter the user never chose from a menu.
 */
export function parseFilters(params: URLSearchParams): FinancialFilters {
  return {
    tab: oneOf(["ledger", "payments"] as const, params.get("tab")) ?? "ledger",
    page: readPage(params.get("page")),
    search: params.get("search") ?? "",
    types: manyOf(REASON_TYPES, params.getAll("types")),
    direction: oneOf(DIRECTIONS, params.get("direction")),
    statuses: manyOf(PAYMENT_STATUSES, params.getAll("statuses")),
    from: readDate(params.get("from")),
    to: readDate(params.get("to")),
  };
}

/**
 * State back into the URL, with every default left out — so the unfiltered
 * first page of the ledger is `/financial` and not a line of noise the user
 * would have to read to see that nothing is filtered.
 */
export function filtersToParams(f: FinancialFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (f.tab !== "ledger") q.set("tab", f.tab);
  if (f.page !== 1) q.set("page", String(f.page));
  if (f.search.trim()) q.set("search", f.search);
  for (const type of f.types) q.append("types", type);
  if (f.direction) q.set("direction", f.direction);
  for (const status of f.statuses) q.append("statuses", status);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  return q;
}
