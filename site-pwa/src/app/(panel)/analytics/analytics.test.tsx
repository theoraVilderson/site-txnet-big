import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import { ApiFile, createApiClient } from "@/lib/api-request";
import { type AnalyticsOverview, exportAnalytics, readAnalytics } from "@/lib/billing/analytics";
import { catalogApi } from "@/lib/catalog-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { downloadBlob } from "../_lib/download";
import { AnalyticsView } from "./_components/AnalyticsView";
import { DEFAULT_FILTERS, calendarOf, filtersOf, searchOf, windowOf } from "./_lib/filters";

/**
 * `/analytics` (F-1001-d, panel-web `contract.analytics.md` "The page",
 * "Overview"). What goes wrong here without anyone seeing it:
 *
 *  - **a view that is not a link.** Every filter lives in the URL: a reload or
 *    a shared link must open the same figures, and a default must not clutter it;
 *  - **a window cut on the wrong month.** "This month" for a Persian reader is
 *    the Jalali month (1 Mehr 1405 = 23 September 2026), not October;
 *  - **a page that polls, or never refreshes.** It re-reads on
 *    `billing.analytics.refreshed` (C-14) and on nothing else;
 *  - **half-built numbers.** While the rollup rebuilds, an alert and no figure;
 *  - **an id where a name belongs.** A product is named by its catalog key,
 *    in the reader's language;
 *  - **an export of something else.** The Export menu (F-1007-b) saves the tab
 *    and filters on screen, and the transport hands back the file, not JSON.
 */

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: () => "/analytics", useSearchParams: vi.fn() }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/context/BrandContext", () => ({ useBrandColor: () => null }));
vi.mock("@visx/responsive", () => ({ ParentSize: ({ children }: { children: (s: { width: number; height: number }) => unknown }) => children({ width: 360, height: 220 }) }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/hooks/useLiveReread", () => ({ useLiveReread: vi.fn() }));
// The picker imports its stylesheet, which the test runner does not load; the custom range is not under test here.
vi.mock("../_components/kit/DatePicker", () => ({ DatePicker: () => null }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("@/lib/billing/analytics", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/billing/analytics")>()), readAnalytics: vi.fn(), exportAnalytics: vi.fn() }));
vi.mock("../_lib/download", () => ({ downloadBlob: vi.fn() }));
vi.mock("@/lib/catalog-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog-api")>()), catalogApi: { texts: vi.fn() } }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const params = (query: string) => new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>;
const replace = vi.fn();

const kpi = (value: number, previous: number | null = null) => ({ value, previous, delta: null });
const money = (v: string) => ({ value: { USD: v }, previous: null, delta: { USD: null } });
const overview: AnalyticsOverview = {
  currencies: ["USD"],
  kpis: {
    net: money("90.00"), gross: money("100.00"), refunds: money("10.00"), topUps: money("50.00"), aov: money("30.00"), arpu: money("10.00"),
    orders: kpi(3), buyers: kpi(9), newBuyers: kpi(4), returningBuyers: kpi(5), renewal: null, activeGrants: kpi(12),
    bytesUsed: { value: "1000", previous: null, delta: null },
  },
  series: { salesPackage: [{ USD: "60.00" }, { USD: "20.00" }], salesUsage: [{ USD: "5.00" }, { USD: "5.00" }], topUps: [{ USD: "30.00" }, { USD: "20.00" }], orders: [2, 1], newBuyers: [3, 1], returningBuyers: [2, 3] },
  previousSeries: null,
  byProduct: { top: [{ productId: PRODUCT, net: { USD: "80.00" }, orders: 2, buyers: 6, share: 0.8889 }], other: null },
  calendar: [{ day: "2026-10-15", net: { USD: "65.00" } }, { day: "2026-10-16", net: { USD: "25.00" } }],
};
const answer = (over: object = {}) => ({
  tab: "overview" as const, query: { from: "2026-09-17", to: "2026-10-16", compare: "previous" as const, calendar: "gregorian" as const },
  refreshedAt: new Date(Date.now() - 3 * 60_000).toISOString(), rebuilding: false as const, granularity: "day" as const, buckets: ["2026-10-15", "2026-10-16"], suppressed: false,
  names: { products: [{ id: PRODUCT, nameKey: "catalog.products.gold.name" }], panels: [] },
  ...overview, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ replace } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(params(""));
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(usePanelSession).mockReturnValue({ me: { tenant: { id: TENANT }, permissions: ["*"] }, isLoading: false } as unknown as ReturnType<typeof usePanelSession>);
  vi.mocked(catalogApi.texts).mockResolvedValue({ products: { gold: { name: "Gold plan" } } });
  vi.mocked(readAnalytics).mockResolvedValue(answer() as never);
});

describe("the filters live in the URL", () => {
  it("round-trips every filter, leaves the defaults off, and falls back on a value it does not know", () => {
    const shared = `range=custom&from=2026-09-01&to=2026-09-30&compare=year&product=${PRODUCT}`;
    const f = filtersOf(params(shared));
    expect(f).toMatchObject({ range: "custom", from: "2026-09-01", to: "2026-09-30", compare: "year", product: PRODUCT });
    expect(filtersOf(params(searchOf(f)))).toEqual(f);
    expect(searchOf(DEFAULT_FILTERS)).toBe("");
    expect(filtersOf(params("range=forever&compare=sideways&tab=nope"))).toEqual(DEFAULT_FILTERS);
    // A custom range that ends before it starts is not a window.
    expect(filtersOf(params("range=custom&from=2026-09-30&to=2026-09-01")).range).toBe(DEFAULT_FILTERS.range);
  });

  it("cuts this month and last month in the reader's calendar", () => {
    expect(calendarOf("fa")).toBe("jalali");
    expect(calendarOf("en")).toBe("gregorian");
    const at = (range: string, calendar: "jalali" | "gregorian") => windowOf({ ...DEFAULT_FILTERS, range: range as never }, "2026-10-16", calendar);
    expect(at("thisMonth", "jalali")).toEqual({ from: "2026-09-23", to: "2026-10-16" });
    expect(at("lastMonth", "jalali")).toEqual({ from: "2026-08-23", to: "2026-09-22" });
    expect(at("thisMonth", "gregorian")).toEqual({ from: "2026-10-01", to: "2026-10-16" });
    expect(at("30d", "gregorian")).toEqual({ from: "2026-09-17", to: "2026-10-16" });
    expect(at("today", "gregorian")).toEqual({ from: "2026-10-16", to: "2026-10-16" });
  });
});

describe("AnalyticsView", () => {
  it("reads the session's tenant with the URL's filters and names a product by its catalog text", async () => {
    vi.mocked(useSearchParams).mockReturnValue(params(`compare=none&product=${PRODUCT}`));
    render(<AnalyticsView />);
    await screen.findAllByText("Gold plan");
    expect(readAnalytics).toHaveBeenCalledWith(TENANT, "overview", expect.objectContaining({ compare: "none", product: PRODUCT, calendar: "gregorian" }));
  });

  it("re-reads on the rollup's event on its tenant channel, never on a timer", async () => {
    render(<AnalyticsView />);
    await screen.findAllByText("Gold plan");
    const [channel, types, reread] = vi.mocked(useLiveReread).mock.calls.at(-1)!;
    expect(channel).toBe(`tenant:${TENANT}`);
    expect(types).toEqual(["billing.analytics.refreshed"]);
    act(() => reread("event"));
    await waitFor(() => expect(readAnalytics).toHaveBeenCalledTimes(2));
  });

  it("shows the rebuild instead of half-built numbers", async () => {
    vi.mocked(readAnalytics).mockResolvedValue({ tab: "overview", query: answer().query, refreshedAt: null, rebuilding: true } as never);
    render(<AnalyticsView />);
    expect(await screen.findByText("analytics.rebuilding.title")).toBeTruthy();
    expect(screen.queryByText("Gold plan")).toBeNull();
  });

  it("puts a filter change in the URL, not in state", async () => {
    render(<AnalyticsView />);
    await screen.findAllByText("Gold plan");
    fireEvent.click(screen.getAllByRole("radio", { name: /compares\.year/ })[0]);
    expect(replace).toHaveBeenCalledWith("/analytics?compare=year", { scroll: false });
  });
});

describe("the Export menu (F-1007-b)", () => {
  it("saves the tab on screen, with the URL's filters, in the format picked", async () => {
    const file = new ApiFile(new Blob(["x"]), "analytics-overview-2026-09-17-2026-10-16.xlsx");
    vi.mocked(exportAnalytics).mockResolvedValue(file);
    vi.mocked(useSearchParams).mockReturnValue(params(`compare=year&product=${PRODUCT}`));
    render(<AnalyticsView />);
    await screen.findAllByText("Gold plan");
    fireEvent.click(screen.getByRole("button", { name: "analytics.export.button" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "analytics.export.xlsx" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(file.fileName, file.blob));
    expect(exportAnalytics).toHaveBeenCalledWith(TENANT, "overview", expect.objectContaining({ compare: "year", product: PRODUCT }), "xlsx");
  });

  it("hands back an attachment as a file, its name from the header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("a,b", { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="analytics-overview-2026-09-01-2026-09-30.csv"' } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const got = await createApiClient({ baseUrl: "https://x/api", service: "billing-service" })<ApiFile>("/f");
      expect(got).toBeInstanceOf(ApiFile);
      expect(got.fileName).toBe("analytics-overview-2026-09-01-2026-09-30.csv");
      expect(await got.blob.text()).toBe("a,b");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
