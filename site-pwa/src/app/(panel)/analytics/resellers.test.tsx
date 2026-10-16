import { render, screen, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import { type AnalyticsResellers, readAnalytics } from "@/lib/billing/analytics";
import { catalogApi } from "@/lib/catalog-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { AnalyticsView } from "./_components/AnalyticsView";
import { ResellersTab } from "./_components/ResellersTab";
import { resellersVisible } from "./_lib/resellers";

/**
 * The Resellers tab and the Overview's top five (F-1001-i, panel-web
 * `contract.analytics.md` Overview item 6 and "Other tabs"; billing
 * `contract.analytics-tabs.md` "Resellers"). What goes wrong here quietly:
 *
 *  - **the tab offered to whom billing refuses.** Only the platform's own view,
 *    to its staff with `platform.report.read`; a reseller never sees the link;
 *  - **a figure where billing hid one.** A sparkline point under 5 buyers is
 *    null and stays a gap, never a zero;
 *  - **a leaderboard that goes stale.** It re-reads on any reseller's rollup
 *    event on the platform's channel, never on a timer.
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

const PLATFORM = "11111111-1111-4111-8111-111111111111";
const ACME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const params = (query: string) => new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>;

const row = (id: string, name: string, net: string) => ({
  resellerId: id,
  name,
  net: { value: { USD: net }, previous: { USD: "10.00" }, delta: { USD: 1 } },
  topUps: { USD: "5.00" },
  buyers: 12,
  activeGrants: 30,
  sparkline: [{ USD: "1.00" }, null],
});
const resellers: AnalyticsResellers = { currencies: ["USD"], total: 7, resellers: [row(ACME, "Acme VPN", "100.00"), ...[2, 3, 4, 5, 6].map((n) => row(`${n}`.repeat(8) + BETA.slice(8), `R${n}`, `${10 - n}.00`))] };
const head = (tab: string) => ({
  tab,
  query: { from: "2026-09-17", to: "2026-10-16", compare: "previous", calendar: "gregorian" },
  refreshedAt: new Date().toISOString(),
  rebuilding: false,
  granularity: "day",
  buckets: ["2026-10-15", "2026-10-16"],
  suppressed: false,
  names: { products: [], panels: [], meters: [], kinds: [] },
});
const kpi = { value: 0, previous: null, delta: null };
const money = { value: { USD: "0.00" }, previous: null, delta: { USD: null } };
const overview = {
  currencies: ["USD"],
  kpis: { net: money, gross: money, refunds: money, topUps: money, aov: money, arpu: money, orders: kpi, buyers: kpi, newBuyers: kpi, returningBuyers: kpi, renewal: { rate: null, renewed: 0, lapsed: 0, pending: 0 }, activeGrants: kpi, bytesUsed: { value: "0", previous: null, delta: null } },
  series: { salesPackage: [], salesUsage: [], topUps: [], orders: [], newBuyers: [], returningBuyers: [] },
  previousSeries: null,
  byProduct: { top: [], other: null },
  calendar: [],
  insights: [],
  usage: [],
};

const staff = (permissions: string[]) => ({ me: { userId: "u", tenant: { id: PLATFORM, type: "platform_owner", isOwner: false }, permissions }, isLoading: false });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(params(""));
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(catalogApi.texts).mockResolvedValue({});
  // The tenant: channel needs its own key (`tenantChannelOf`).
  vi.mocked(usePanelSession).mockReturnValue(staff(["platform.report.read", "realtime.tenant.read"]) as unknown as ReturnType<typeof usePanelSession>);
  vi.mocked(readAnalytics).mockImplementation(async (_tenant, tab) => ({ ...head(tab), ...(tab === "resellers" ? resellers : overview) }) as never);
});

describe("resellersVisible", () => {
  it("is the platform's own view, to its staff with the report key — billing's door", () => {
    const me = (type: "platform_owner" | "reseller", permissions: string[]) => ({ tenant: { type }, permissions });
    expect(resellersVisible(me("platform_owner", ["platform.report.read"]), undefined)).toBe(true);
    expect(resellersVisible(me("platform_owner", ["*"]), undefined)).toBe(true);
    expect(resellersVisible(me("platform_owner", ["platform.report.read"]), ACME)).toBe(false);
    expect(resellersVisible(me("platform_owner", ["analytics.read"]), undefined)).toBe(false);
    expect(resellersVisible(me("reseller", ["*"]), undefined)).toBe(false);
  });
});

describe("ResellersTab", () => {
  it("lists every reseller with its figures, its name opening its own analytics, and says how many there are", () => {
    render(<ResellersTab resellers={resellers} currency="USD" />);
    const links = screen.getAllByRole("link", { name: "Acme VPN" });
    expect(links[0].getAttribute("href")).toBe(`/my-resellers/${ACME}/analytics`);
    expect(screen.getAllByText(/analytics\.resellers\.count:6,7/).length).toBeGreaterThan(0);
  });
});

describe("AnalyticsView for the platform's staff", () => {
  it("offers the Resellers tab and draws the top five on the Overview, re-read on any reseller's event", async () => {
    render(<AnalyticsView />);
    await waitFor(() => expect(readAnalytics).toHaveBeenCalledWith(PLATFORM, "resellers", expect.anything()));
    expect(screen.getAllByText("analytics.tabs.resellers").length).toBeGreaterThan(0);
    expect(await screen.findAllByText("analytics.resellers.top.title")).toBeTruthy();
    // Five, the sixth left to the tab.
    expect(screen.queryAllByText("R6")).toHaveLength(0);
    expect(screen.getAllByText("R5").length).toBeGreaterThan(0);
    const types = vi.mocked(useLiveReread).mock.calls.filter((c) => c[0] === `tenant:${PLATFORM}`).map((c) => c[1]);
    expect(types).toContainEqual(expect.arrayContaining(["billing.analytics.reseller_refreshed"]));
  });

  it("neither offers the tab nor asks for it without the report key", async () => {
    vi.mocked(usePanelSession).mockReturnValue(staff(["analytics.read"]) as unknown as ReturnType<typeof usePanelSession>);
    render(<AnalyticsView />);
    await waitFor(() => expect(readAnalytics).toHaveBeenCalled());
    expect(readAnalytics).not.toHaveBeenCalledWith(PLATFORM, "resellers", expect.anything());
    expect(screen.queryByText("analytics.tabs.resellers")).toBeNull();
  });
});
