import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { type AnalyticsCohorts, readAnalytics } from "@/lib/billing/analytics";
import { catalogApi } from "@/lib/catalog-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { CohortGrid } from "../_components/kit/charts";
import { AnalyticsView } from "./_components/AnalyticsView";
import { CohortsTab } from "./_components/CohortsTab";
import { channelCurves, gridOf } from "./_lib/cohorts";

/**
 * The Cohorts tab (F-1004-b, panel-web `contract.analytics-tabs.md` "Cohorts";
 * billing `cohorts`, F-1004-a) and the kit's `CohortGrid`. What goes wrong
 * here quietly:
 *
 *  - **a cell drawn for a month a cohort has not lived,** read as a zero —
 *    it is empty, never 0%;
 *  - **a hidden cohort's row drawn with figures** — it reads "fewer than 5";
 *  - **colour alone:** every cell says its value in words, the colour only
 *    helps the eye (rule 6);
 *  - **a channel's curve drawn past where billing answered,** or a channel
 *    named by its raw key where the page has words for it.
 */

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: () => "/analytics", useSearchParams: vi.fn() }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/context/BrandContext", () => ({ useBrandColor: () => null }));
vi.mock("@visx/responsive", () => ({ ParentSize: ({ children }: { children: (s: { width: number; height: number }) => unknown }) => children({ width: 360, height: 220 }) }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/hooks/useLiveReread", () => ({ useLiveReread: vi.fn() }));
vi.mock("../_components/kit/DatePicker", () => ({ DatePicker: () => null }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("@/lib/billing/analytics", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/billing/analytics")>()), readAnalytics: vi.fn() }));
vi.mock("@/lib/catalog-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog-api")>()), catalogApi: { texts: vi.fn() } }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const [SEP, OCT, NOV] = ["2026-09-01", "2026-10-01", "2026-11-01"];
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const params = (query: string) => new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>;
const usd = (v: string) => ({ USD: v });

const cohorts: AnalyticsCohorts = {
  currencies: ["USD"],
  months: [SEP, OCT, NOV],
  cohorts: [{ cohort: SEP, users: 10 }, { cohort: OCT, users: 6 }, { cohort: NOV, people: "fewer_than_5" }],
  cells: [
    { cohort: SEP, k: 0, share: 1, netPerUser: usd("10.00"), ltv: usd("10.00") },
    { cohort: SEP, k: 1, share: 0.4, netPerUser: usd("4.00"), ltv: usd("14.00") },
    { cohort: SEP, k: 2, share: 0.3, netPerUser: usd("3.00"), ltv: usd("17.00") },
    { cohort: OCT, k: 0, share: 1, netPerUser: usd("8.00"), ltv: usd("8.00") },
    { cohort: OCT, k: 1, share: 0.5, netPerUser: usd("5.00"), ltv: usd("13.00") },
  ],
  channels: [{ source: "web", users: 11 }, { source: "telegram", users: 5 }],
  channelLtv: [
    { source: "web", k: 0, ltv: usd("9.00") },
    { source: "web", k: 1, ltv: usd("13.50") },
    { source: "telegram", k: 0, ltv: usd("10.00") },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(catalogApi.texts).mockResolvedValue({});
});

describe("gridOf", () => {
  it("pivots the cells by cohort and month k, a month not yet lived left empty, never zero", () => {
    const grid = gridOf(cohorts, "share", "USD");
    expect(grid.columns).toBe(3);
    expect(grid.rows[0]).toMatchObject({ cohort: SEP, users: 10, values: [1, 0.4, 0.3] });
    expect(grid.rows[1]).toMatchObject({ cohort: OCT, users: 6, values: [1, 0.5, null] });
    expect(grid.rows[2]).toEqual({ cohort: NOV, hidden: true });
    expect(gridOf(cohorts, "ltv", "USD").rows[0]).toMatchObject({ values: [10, 14, 17] });
  });
});

describe("channelCurves", () => {
  it("draws each channel only as far as billing answered it", () => {
    expect(channelCurves(cohorts, "USD", 3)).toEqual([
      { source: "web", values: [9, 13.5, null] },
      { source: "telegram", values: [10, null, null] },
    ]);
  });
});

describe("CohortGrid", () => {
  it("writes every cell's value, shades it by its share of the largest, and says a hidden row in words", () => {
    render(
      <CohortGrid
        label="grid"
        rowHeader="Cohort"
        sizeHeader="Size"
        columns={["M0", "M1"]}
        rows={[
          { id: "a", label: "Sep", size: "10", values: [1, null], display: ["100%", ""] },
          { id: "b", label: "Oct", hidden: "fewer than 5" },
        ]}
      />,
    );
    const table = screen.getByRole("table", { name: "grid" });
    const full = within(table).getByText("100%");
    expect(full.closest("td")?.getAttribute("style")).toContain("100%");
    expect(within(table).getByText("fewer than 5")).toBeTruthy();
  });
});

describe("CohortsTab", () => {
  it("switches the grid between share, net per member and LTV, and names a channel in words", () => {
    render(<CohortsTab cohorts={cohorts} currency="USD" formatMonth={(d) => d.slice(0, 7)} stale={false} />);
    const grid = screen.getByRole("table", { name: "analytics.cohorts.grid.title" });
    expect(within(grid).getAllByText("40%").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("radio", { name: "analytics.cohorts.metrics.ltv" }));
    expect(within(screen.getByRole("table", { name: "analytics.cohorts.grid.title" })).getByText(/17/)).toBeTruthy();
    expect(screen.getAllByText("analytics.customers.sources.web").length).toBeGreaterThan(0);
  });
});

describe("AnalyticsView on Cohorts", () => {
  it("offers the tab and reads cohorts", async () => {
    vi.mocked(useSearchParams).mockReturnValue(params("tab=cohorts"));
    vi.mocked(usePanelSession).mockReturnValue({
      me: { userId: "u", tenant: { id: TENANT, type: "reseller", isOwner: true }, permissions: ["analytics.read"] },
      isLoading: false,
    } as unknown as ReturnType<typeof usePanelSession>);
    vi.mocked(readAnalytics).mockResolvedValue({
      tab: "cohorts",
      query: { from: "2026-09-01", to: "2026-11-30", compare: "previous", calendar: "gregorian" },
      refreshedAt: new Date().toISOString(),
      rebuilding: false,
      granularity: "week",
      buckets: [],
      suppressed: false,
      names: { products: [], panels: [], meters: [], kinds: [] },
      ...cohorts,
    } as never);
    render(<AnalyticsView />);
    await waitFor(() => expect(readAnalytics).toHaveBeenCalledWith(TENANT, "cohorts", expect.anything()));
    expect(screen.getAllByText("analytics.tabs.cohorts").length).toBeGreaterThan(0);
    expect(await screen.findByRole("table", { name: "analytics.cohorts.grid.title" })).toBeTruthy();
  });
});
