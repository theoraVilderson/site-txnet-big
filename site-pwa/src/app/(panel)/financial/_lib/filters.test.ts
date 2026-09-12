import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  EMPTY_FILTERS,
  endOfDayInstant,
  filtersToParams,
  forTab,
  hasNarrowingFilter,
  ledgerQuery,
  parseFilters,
  paymentsQuery,
  startOfDayInstant,
  type FinancialFilters,
} from "./filters";

/**
 * F-093-d. Two things break silently on this page, and both are the reason
 * this file exists at all rather than the query being built inline.
 *
 * **1. A day is not an instant.** The user picks a day on a calendar — Jalali
 * in Persian, Gregorian otherwise — and `billing` takes ISO-8601 instants
 * (`domains/billing/contract.history.md`). The panel owns the calendar and the
 * zone, so it is the panel that has to resolve "12 Shahrivar" into the moment
 * that day began *where this browser is* and the moment it ended. Legacy sent
 * `۱۴۰۵/۰۶/۱۰` to its server action and let it guess, which answered two
 * different pages to two users who picked the same day.
 *
 * **2. The two lists never share a query.** A ledger row and a payment attempt
 * are separate lists, because in legacy they were one Mongo collection and the
 * page counted a failed top-up as a movement (F-092-n's note). A `statuses`
 * filter leaking onto the ledger call, or `types` onto the payments call, is
 * that merge growing back through the query string.
 */

const filters = (over: Partial<FinancialFilters> = {}): FinancialFilters => ({
  ...EMPTY_FILTERS,
  ...over,
});

/** The local wall-clock parts of an instant — independent of the runner's zone. */
const wallClock = (iso: string) => {
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
      d.getSeconds(),
    ).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`,
  };
};

const query = (q: string) => new URLSearchParams(q);

describe("a picked day becomes an instant in the viewer's own zone", () => {
  it("starts the day at local midnight", () => {
    expect(wallClock(startOfDayInstant("2026-09-12"))).toEqual({
      date: "2026-09-12",
      time: "00:00:00.000",
    });
  });

  it("ends the day at the last millisecond of it, not at the next midnight", () => {
    // A `to` of the next midnight would pull in a transaction made at 00:00:00
    // the following day, which is the day after the one the user picked.
    expect(wallClock(endOfDayInstant("2026-09-12"))).toEqual({
      date: "2026-09-12",
      time: "23:59:59.999",
    });
  });

  it("emits a UTC instant, whatever the local offset is", () => {
    expect(startOfDayInstant("2026-09-12")).toMatch(/Z$/);
    expect(new Date(startOfDayInstant("2026-09-12")).toISOString()).toBe(
      startOfDayInstant("2026-09-12"),
    );
  });

  it("puts both ends of a one-day range on the wire as instants", () => {
    const q = query(ledgerQuery(filters({ from: "2026-09-12", to: "2026-09-12" })));
    expect(q.get("from")).toBe(startOfDayInstant("2026-09-12"));
    expect(q.get("to")).toBe(endOfDayInstant("2026-09-12"));
    // Never the calendar string the picker showed.
    expect(q.get("from")).not.toBe("2026-09-12");
  });
});

describe("the ledger query and the payments query stay apart", () => {
  const both = filters({
    types: ["payment_gateway"],
    direction: "credit",
    search: "gateway",
    statuses: ["failed"],
  });

  it("sends the ledger only the ledger's filters", () => {
    const q = query(ledgerQuery(both));
    expect(q.getAll("types")).toEqual(["payment_gateway"]);
    expect(q.get("direction")).toBe("credit");
    expect(q.get("search")).toBe("gateway");
    expect(q.getAll("statuses")).toEqual([]);
  });

  it("sends payments only the payment statuses", () => {
    const q = query(paymentsQuery(both));
    expect(q.getAll("statuses")).toEqual(["failed"]);
    expect(q.getAll("types")).toEqual([]);
    expect(q.get("direction")).toBeNull();
    expect(q.get("search")).toBeNull();
  });

  it("repeats a multi-valued filter rather than joining it", () => {
    // `many()` in `wallet-history.schema.ts` reads repeats, not a CSV.
    const q = query(paymentsQuery(filters({ statuses: ["pending", "failed"] })));
    expect(q.getAll("statuses")).toEqual(["pending", "failed"]);
  });
});

describe("an absent filter is absent from the query", () => {
  it("asks for a page and nothing else when nothing is filtered", () => {
    expect([...query(ledgerQuery(EMPTY_FILTERS)).keys()].sort()).toEqual(["page", "pageSize"]);
    expect([...query(paymentsQuery(EMPTY_FILTERS)).keys()].sort()).toEqual(["page", "pageSize"]);
  });

  it("drops a search the user cleared instead of sending an empty term", () => {
    // An empty `search` is not a blank filter to the service: it reaches
    // `foldedSearch`, and a term matching no label answers an empty page.
    expect(query(ledgerQuery(filters({ search: "   " }))).has("search")).toBe(false);
  });

  it("sends one end of a half-open range without inventing the other", () => {
    const q = query(ledgerQuery(filters({ from: "2026-09-01" })));
    expect(q.get("from")).toBe(startOfDayInstant("2026-09-01"));
    expect(q.has("to")).toBe(false);
  });

  it("pages with the size the table renders", () => {
    const q = query(ledgerQuery(filters({ page: 3 })));
    expect(q.get("page")).toBe("3");
    expect(q.get("pageSize")).toBe(String(DEFAULT_PAGE_SIZE));
  });
});

describe("the URL is the page's state", () => {
  it("round-trips every filter through the query string", () => {
    const state = filters({
      tab: "payments",
      page: 4,
      search: "transfer",
      types: ["wallet_transfer_in", "wallet_transfer_out"],
      direction: "debit",
      statuses: ["success", "pending"],
      from: "2026-01-01",
      to: "2026-02-02",
    });
    expect(parseFilters(filtersToParams(state))).toEqual(state);
  });

  it("reads an empty query as the unfiltered first page of the ledger", () => {
    expect(parseFilters(query(""))).toEqual(EMPTY_FILTERS);
  });

  it("ignores a value that is not one the API accepts", () => {
    // The query string is user-editable. A junk `direction` must not be
    // forwarded for the service to reject with a 400 the user cannot act on.
    const parsed = parseFilters(query("direction=sideways&types=nonsense&statuses=maybe&tab=ledger"));
    expect(parsed.direction).toBeNull();
    expect(parsed.types).toEqual([]);
    expect(parsed.statuses).toEqual([]);
  });

  it("reads a page that is not a positive whole number as the first page", () => {
    expect(parseFilters(query("page=0")).page).toBe(1);
    expect(parseFilters(query("page=-2")).page).toBe(1);
    expect(parseFilters(query("page=two")).page).toBe(1);
  });

  it("leaves an absent filter out of the URL, so a clean page has a clean address", () => {
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe("");
  });
});

describe("switching to the other list", () => {
  const before = filters({
    tab: "ledger",
    page: 4,
    search: "transfer",
    types: ["wallet_transfer_in"],
    direction: "credit",
    from: "2026-01-01",
    to: "2026-02-02",
  });

  it("keeps the range, because it is the same question of either list", () => {
    const after = forTab(before, "payments");
    expect(after.from).toBe("2026-01-01");
    expect(after.to).toBe("2026-02-02");
  });

  it("drops the filters the other list cannot use", () => {
    // A reason type means nothing to a payment attempt. Left set, it would
    // light the filter dot over a list it does not narrow — and `paymentsQuery`
    // would keep silently discarding it.
    const after = forTab(before, "payments");
    expect(after.search).toBe("");
    expect(after.types).toEqual([]);
    expect(after.direction).toBeNull();
    expect(hasNarrowingFilter(after)).toBe(true); // the range still narrows it
  });

  it("starts the other list at its first page", () => {
    expect(forTab(before, "payments").page).toBe(1);
  });

  it("leaves nothing behind when no range was picked", () => {
    expect(forTab(filters({ statuses: ["failed"], page: 3 }), "ledger")).toEqual(EMPTY_FILTERS);
  });
});

describe("the filter button's dot", () => {
  it("is off when only the page and the tab are set", () => {
    expect(hasNarrowingFilter(filters({ page: 7, tab: "payments" }))).toBe(false);
  });

  it("is on for any filter that narrows the list", () => {
    expect(hasNarrowingFilter(filters({ search: "x" }))).toBe(true);
    expect(hasNarrowingFilter(filters({ from: "2026-01-01" }))).toBe(true);
    expect(hasNarrowingFilter(filters({ types: ["payment_gateway"] }))).toBe(true);
    expect(hasNarrowingFilter(filters({ direction: "credit" }))).toBe(true);
    expect(hasNarrowingFilter(filters({ statuses: ["failed"] }))).toBe(true);
  });
});
