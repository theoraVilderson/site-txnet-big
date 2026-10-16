import { render, screen, waitFor, within } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { type AnalyticsCapacity, type CapacityPanel, readAnalytics } from "@/lib/billing/analytics";
import { catalogApi } from "@/lib/catalog-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { AnalyticsView } from "./_components/AnalyticsView";
import { CapacityTab } from "./_components/CapacityTab";
import { SOON_DAYS, ratioOf, urgencyOf } from "./_lib/capacity";

/**
 * The Capacity tab (F-1005-b, panel-web `contract.analytics-tabs.md`
 * "Capacity"; billing `capacity`, F-1005-a). What goes wrong here quietly:
 *
 *  - **"full" read as "fine".** A panel full today, or within a week, says so
 *    in words beside its colour; one with no date says it will not fill;
 *  - **a margin with no cost.** A panel with no price says "no cost set",
 *    never a margin of its whole net;
 *  - **an alert that cannot be acted on.** The link to Systems is offered only
 *    where a price can be set — the platform's own view;
 *  - **a byte count through a float too early.** Bytes stay strings until a
 *    ratio is taken.
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
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const params = (query: string) => new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>;

const panel = (over: Partial<CapacityPanel>): CapacityPanel => ({
  panelId: "p",
  name: "Panel",
  usedBytes: "0",
  perDayBytes: null,
  projectedBytes: null,
  allowanceBytes: null,
  trafficFullOn: null,
  observedDays: null,
  clients: null,
  maxClients: null,
  clientsPerDay: null,
  clientsFullOn: null,
  fullOn: null,
  daysUntilFull: null,
  monthlyCostUsd: null,
  projectedCostUsd: null,
  net: null,
  cost: null,
  margin: null,
  marginRate: null,
  loss: false,
  ...over,
});

const capacity: AnalyticsCapacity = {
  currencies: ["USD"],
  month: "2026-10-01",
  today: "2026-10-16",
  panels: [
    panel({
      panelId: "a",
      name: "Frankfurt",
      usedBytes: "150",
      projectedBytes: "310",
      allowanceBytes: "200",
      fullOn: "2026-10-20",
      daysUntilFull: 4,
      clients: 64,
      maxClients: 80,
      monthlyCostUsd: "31.00",
      projectedCostUsd: "31.00",
      net: { USD: "20.00" },
      cost: { USD: "31.00" },
      margin: { USD: "-11.00" },
      loss: true,
    }),
    panel({ panelId: "b", name: "Tehran", usedBytes: "10", projectedBytes: "20", clients: 3 }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(catalogApi.texts).mockResolvedValue({});
});

describe("urgencyOf and ratioOf", () => {
  it("names full today, within a week, later and never", () => {
    expect(urgencyOf({ daysUntilFull: 0 })).toBe("full");
    expect(urgencyOf({ daysUntilFull: SOON_DAYS })).toBe("soon");
    expect(urgencyOf({ daysUntilFull: SOON_DAYS + 1 })).toBe("later");
    expect(urgencyOf({ daysUntilFull: null })).toBe("none");
  });

  it("takes a ratio only with a whole", () => {
    expect(ratioOf("310", "200")).toBe(1.55);
    expect(ratioOf("10", null)).toBeNull();
    expect(ratioOf(3, 0)).toBeNull();
  });
});

describe("CapacityTab", () => {
  it("says when each panel fills in words, and a loss beside its margin", () => {
    render(<CapacityTab capacity={capacity} currency="USD" formatDay={(d) => d} systemsHref="/systems" stale={false} />);
    const list = screen.getAllByRole("listitem");
    expect(within(list[0]).getByText("analytics.capacity.full.on:2026-10-20,4")).toBeTruthy();
    expect(within(list[0]).getByText("analytics.profit.loss")).toBeTruthy();
    expect(within(list[1]).getByText("analytics.capacity.full.none")).toBeTruthy();
    expect(within(list[1]).getByText("analytics.capacity.money.noCost")).toBeTruthy();
  });

  it("names the unpriced panels, with a way to price them only where one can", () => {
    const { rerender } = render(<CapacityTab capacity={capacity} currency="USD" formatDay={(d) => d} systemsHref="/systems" stale={false} />);
    expect(screen.getByText(/analytics\.capacity\.noPrice\.body:Tehran/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "analytics.capacity.noPrice.action" }).getAttribute("href")).toBe("/systems");
    rerender(<CapacityTab capacity={capacity} currency="USD" formatDay={(d) => d} systemsHref={null} stale={false} />);
    expect(screen.queryByRole("link", { name: "analytics.capacity.noPrice.action" })).toBeNull();
  });
});

describe("AnalyticsView on Capacity", () => {
  it("offers the tab and reads capacity", async () => {
    vi.mocked(useSearchParams).mockReturnValue(params("tab=capacity"));
    vi.mocked(usePanelSession).mockReturnValue({
      me: { userId: "u", tenant: { id: TENANT, type: "reseller", isOwner: true }, permissions: ["analytics.read"] },
      isLoading: false,
    } as unknown as ReturnType<typeof usePanelSession>);
    vi.mocked(readAnalytics).mockResolvedValue({
      tab: "capacity",
      query: { from: "2026-09-17", to: "2026-10-16", compare: "previous", calendar: "gregorian" },
      refreshedAt: new Date().toISOString(),
      rebuilding: false,
      granularity: "day",
      buckets: [],
      suppressed: false,
      names: { products: [], panels: [], meters: [], kinds: [] },
      ...capacity,
    } as never);
    render(<AnalyticsView />);
    expect(screen.getByRole("link", { name: "analytics.tabs.capacity" })).toBeTruthy();
    await waitFor(() => expect(readAnalytics).toHaveBeenCalledWith(TENANT, "capacity", expect.anything()));
    expect(await screen.findByText("Frankfurt")).toBeTruthy();
  });
});
