import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import { type AnalyticsMargin, FEWER_THAN_5, readAnalytics, setAnalyticsSettings } from "@/lib/billing/analytics";
import { catalogApi } from "@/lib/catalog-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { AnalyticsView } from "./_components/AnalyticsView";
import { ProfitTab } from "./_components/ProfitTab";

/**
 * The Profit tab (F-1001-m, panel-web `contract.analytics-tabs.md` "Profit";
 * billing `margin`, F-1001-l). What goes wrong here quietly:
 *
 *  - **a loss in colour alone.** A loss-making row says so with an icon and a
 *    word (chart rule 4), never only red;
 *  - **a margin from a panel that costs nothing.** A panel with no cost set
 *    makes its margin look perfect: the page says which, and where to set it;
 *  - **a figure where billing hid one.** A row under 5 buyers reads "fewer
 *    than 5"; no user list is drawn where billing answers none;
 *  - **a margin rate from nothing.** No net is a dash, not 0% or -100%;
 *  - **a product with no cost read as 100% margin** (F-1002-h, ADR-0151). It
 *    says "no cost set" in its row, and a notice names it with a link to the
 *    catalog where it is set; an answer cached before the field existed draws;
 *  - **a stale platform view.** Its per-reseller block moves with any
 *    reseller's pass, so it re-reads on that event too.
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
vi.mock("@/lib/billing/analytics", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/billing/analytics")>()), readAnalytics: vi.fn(), setAnalyticsSettings: vi.fn() }));
vi.mock("@/lib/catalog-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog-api")>()), catalogApi: { texts: vi.fn() } }));

const PLATFORM = "11111111-1111-4111-8111-111111111111";
const PANEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER = "44444444-4444-4444-8444-444444444444";
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const params = (query: string) => new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>;

const usd = (v: string) => ({ USD: v });
const money = (v: string) => ({ value: usd(v), previous: usd("0.00"), delta: { USD: "new" as const } });
const cell = (id: string | null, net: string, cost: string, margin: string, marginRate: number | null, loss: boolean) => ({ id, net: usd(net), cost: usd(cost), margin: usd(margin), marginRate, loss });

const margin: AnalyticsMargin = {
  currencies: ["USD"],
  totals: { net: money("100.00"), cost: money("40.00"), margin: money("60.00"), marginRate: 0.6, previousMarginRate: null },
  costParts: { attributed: usd("30.00"), idle: usd("8.00"), unallocated: usd("2.00") },
  series: { net: [usd("50.00"), usd("50.00")], cost: [usd("20.00"), usd("20.00")], margin: [usd("30.00"), usd("30.00")] },
  products: [cell("p1", "100.00", "30.00", "70.00", 0.7, false), { id: "p2", people: FEWER_THAN_5 }],
  panels: [cell(PANEL, "0.00", "12.00", "-12.00", null, true)],
  users: [{ ...cell(USER, "1.00", "9.00", "-8.00", -8, true), name: "Sara" }],
  resellers: null,
  noCostPanels: [PANEL],
  lossAlertPercent: 20,
};

const head = {
  tab: "margin" as const,
  query: { from: "2026-09-17", to: "2026-10-16", compare: "previous" as const, calendar: "gregorian" as const },
  refreshedAt: new Date().toISOString(),
  rebuilding: false as const,
  granularity: "day" as const,
  buckets: ["2026-10-15", "2026-10-16"],
  suppressed: false,
  names: { products: [{ id: "p1", nameKey: "catalog.p1" }], panels: [{ id: PANEL, name: "Frankfurt" }], meters: [], kinds: [] },
};

const draw = (body: Partial<AnalyticsMargin> = {}, setting: { tenantId: string; onSaved: () => void } | null = null) =>
  render(
    <ProfitTab
      margin={{ ...margin, ...body }}
      x={["15 Oct", "16 Oct"]}
      currency="USD"
      productName={(id) => (id === "p1" ? "Gold plan" : null)}
      panelName={(id) => (id === PANEL ? "Frankfurt" : null)}
      userHref={(id) => `/users/${id}`}
      catalogHref="/catalog"
      setting={setting}
      stale={false}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(catalogApi.texts).mockResolvedValue({});
});

describe("ProfitTab", () => {
  it("marks a loss with its word, not colour alone, and a hidden row in words", () => {
    draw();
    const panels = screen.getByRole("table", { name: "analytics.profit.panels" });
    expect(within(panels).getAllByText("analytics.profit.loss").length).toBeGreaterThan(0);
    const products = screen.getByRole("table", { name: "analytics.profit.products" });
    expect(within(products).queryByText("analytics.profit.loss")).toBeNull();
    expect(within(products).getAllByText("analytics.catalog.fewerThan5").length).toBeGreaterThan(0);
  });

  it("names a panel with no cost set and links to where its cost is set", () => {
    draw();
    const alert = screen.getByText(/analytics\.profit\.noCost\.title/).closest("[role=alert], [role=status]") as HTMLElement;
    expect(within(alert).getByText(/Frankfurt/)).toBeTruthy();
    expect(within(alert).getByRole("link").getAttribute("href")).toBe("/systems");
  });

  it("writes a margin rate from no net as a dash", () => {
    draw();
    const panels = screen.getByRole("table", { name: "analytics.profit.panels" });
    expect(within(panels).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("lists the losing users with a link to each, and draws no list where billing answers none", () => {
    draw();
    expect(screen.getAllByRole("link", { name: "Sara" })[0].getAttribute("href")).toBe(`/users/${USER}`);
    draw({ users: null, noCostPanels: null });
    expect(screen.getAllByRole("table", { name: "analytics.profit.users" })).toHaveLength(1);
  });
});

describe("ProfitTab, a product with no cost (F-1002-h)", () => {
  const priced = { ...cell("p1", "100.00", "30.00", "70.00", 0.7, false), noCost: false };
  const unpriced = { ...cell("p3", "40.00", "0.00", "40.00", 1, false), noCost: true };

  it("says no cost set in its row, its rate a dash, and names it in a notice that links to the catalog", () => {
    draw({ products: [priced, unpriced], noCostProducts: ["p3"] });
    const products = screen.getByRole("table", { name: "analytics.profit.products" });
    expect(within(products).getAllByText("analytics.profit.noCostSet").length).toBeGreaterThan(0);
    const alert = screen.getByText(/analytics\.profit\.noCostProducts\.title/).closest("[role=alert], [role=status]") as HTMLElement;
    expect(within(alert).getByRole("link").getAttribute("href")).toBe("/catalog");
  });

  it("draws an answer cached before the field existed, with no notice", () => {
    const { noCostProducts: _gone, ...old } = { ...margin, noCostProducts: [] };
    draw(old);
    expect(screen.queryByText(/analytics\.profit\.noCostProducts\.title/)).toBeNull();
  });
});

describe("the loss alert's percent (F-1003)", () => {
  it("saves a whole percent from 0 to 500 for the settings key's holders, and refuses one outside it before asking", async () => {
    vi.mocked(setAnalyticsSettings).mockResolvedValue({ renewalWindowDays: 7, lossAlertPercent: 35 });
    const onSaved = vi.fn();
    draw({}, { tenantId: PLATFORM, onSaved });
    const input = screen.getByLabelText("analytics.profit.lossAlert.label") as HTMLInputElement;
    const save = screen.getByRole("button", { name: "analytics.profit.lossAlert.save" });
    fireEvent.change(input, { target: { value: "501" } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "35" } });
    fireEvent.click(save);
    await waitFor(() => expect(setAnalyticsSettings).toHaveBeenCalledWith(PLATFORM, { lossAlertPercent: 35 }));
    expect(onSaved).toHaveBeenCalled();
  });

  it("draws no form for whom may not change it", () => {
    draw();
    expect(screen.queryByLabelText("analytics.profit.lossAlert.label")).toBeNull();
  });
});

describe("AnalyticsView on Profit", () => {
  it("offers the tab, reads margin, and re-reads on any reseller's pass on the platform's view", async () => {
    vi.mocked(useSearchParams).mockReturnValue(params("tab=margin"));
    vi.mocked(usePanelSession).mockReturnValue({
      me: { userId: "u", tenant: { id: PLATFORM, type: "platform_owner", isOwner: false }, permissions: ["analytics.read", "realtime.tenant.read"] },
      isLoading: false,
    } as unknown as ReturnType<typeof usePanelSession>);
    vi.mocked(readAnalytics).mockResolvedValue({ ...head, ...margin } as never);
    render(<AnalyticsView />);
    await waitFor(() => expect(readAnalytics).toHaveBeenCalledWith(PLATFORM, "margin", expect.anything()));
    expect(screen.getAllByText("analytics.tabs.margin").length).toBeGreaterThan(0);
    expect(await screen.findByRole("table", { name: "analytics.profit.products" })).toBeTruthy();
    const types = vi.mocked(useLiveReread).mock.calls.filter((c) => c[0] === `tenant:${PLATFORM}`).map((c) => c[1]);
    expect(types).toContainEqual(expect.arrayContaining(["billing.analytics.reseller_refreshed"]));
  });
});
