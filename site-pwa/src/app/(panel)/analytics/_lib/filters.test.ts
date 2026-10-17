/**
 * A tab's own default range (panel-web contract.analytics.md "Filter bar").
 *
 * Cohorts are people by the month they first bought, so 30 days holds one
 * cohort and no month k: the tab read as empty (2026-10-17). It opens on the
 * last 12 months unless the reader chose a range. The ways this goes wrong:
 *
 *  - **a range the reader chose is overridden** by the next tab's default;
 *  - **the Overview's 30 days is carried into Cohorts** as if chosen, because
 *    a tab link copies the filters it was built from;
 *  - **the default is written into the URL**, so a shared link pins it.
 */
import { DEFAULT_FILTERS, activeFilterCount, filtersOf, retabbed, searchOf, windowOf } from "./filters";

const params = (s: string) => new URLSearchParams(s);

describe("a tab's own default range", () => {
  it("opens Cohorts on the last 12 months when no range is in the URL, and leaves it out of the link", () => {
    const f = filtersOf(params("tab=cohorts"));
    expect(f.range).toBe("12m");
    expect(windowOf(f, "2026-10-17", "gregorian")).toEqual({ from: "2025-10-18", to: "2026-10-17" });
    expect(searchOf(f)).toBe("tab=cohorts");
    expect(activeFilterCount(f)).toBe(0);
  });

  it("keeps a range the reader put in the URL", () => {
    const f = filtersOf(params("tab=cohorts&range=90d"));
    expect(f.range).toBe("90d");
    expect(searchOf(f)).toBe("tab=cohorts&range=90d");
    expect(activeFilterCount(f)).toBe(1);
  });

  it("gives the next tab its own default when the range was only the last tab's, never a chosen one", () => {
    const overview = filtersOf(params(""));
    expect(searchOf(retabbed(overview, { ...overview, tab: "cohorts" }))).toBe("tab=cohorts");
    const cohorts = filtersOf(params("tab=cohorts"));
    expect(searchOf(retabbed(cohorts, { ...cohorts, tab: "overview" }))).toBe("");
    const chosen = filtersOf(params("range=7d"));
    expect(searchOf(retabbed(chosen, { ...chosen, tab: "cohorts" }))).toBe("tab=cohorts&range=7d");
    // A filter change on the same tab is no tab change.
    expect(retabbed(overview, { ...overview, range: "90d" }).range).toBe("90d");
    expect(DEFAULT_FILTERS.range).toBe("30d");
  });
});
