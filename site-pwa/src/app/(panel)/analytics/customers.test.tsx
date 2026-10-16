import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { type AnalyticsCustomers, setAnalyticsSettings } from "@/lib/billing/analytics";
import { CustomersTab } from "./_components/CustomersTab";
import { renewalWindowEditable } from "./_lib/customers";

/**
 * The Customers tab (F-1001-g, panel-web `contract.analytics.md` "Other tabs";
 * billing `contract.analytics-tabs.md` "Customers"). What goes wrong here
 * without anyone seeing it:
 *
 *  - **pending read as lapsed.** The rate is billing's; pending is said beside
 *    it, never folded into it;
 *  - **a person shown to the platform's staff.** No top-customers table when
 *    billing answers none, and a hidden cell reads "fewer than 5";
 *  - **a window outside 1..30 sent.** The setting refuses it before billing does,
 *    and only a holder of the settings key sees it at all.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/context/BrandContext", () => ({ useBrandColor: () => null }));
vi.mock("@visx/responsive", () => ({ ParentSize: ({ children }: { children: (s: { width: number; height: number }) => unknown }) => children({ width: 360, height: 220 }) }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("@/lib/billing/analytics", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/billing/analytics")>()), setAnalyticsSettings: vi.fn() }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "44444444-4444-4444-8444-444444444444";
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);

const customers: AnalyticsCustomers = {
  currencies: ["USD"],
  renewalWindowDays: 7,
  buyers: { newBuyers: [3, 1], returningBuyers: [2, 3] },
  signups: { total: 10, purchased7: { count: 3, rate: 0.3 }, purchased30: { count: 5, rate: 0.5 }, series: [7, 3], bySource: [{ source: "web", signups: 8 }, { source: "telegram", signups: 2 }] },
  renewal: { rate: 0.75, renewed: 6, lapsed: 2, pending: 5 },
  renewalByProduct: [{ productId: PRODUCT, rate: 0.75, renewed: 6, lapsed: 2, pending: 5 }],
  topCustomers: [{ userId: USER, name: "Sara", net: { USD: "40.00" }, orders: 2 }],
};

const props = (over: Partial<Parameters<typeof CustomersTab>[0]> = {}) => ({
  customers,
  x: ["Oct 15", "Oct 16"],
  currency: "USD",
  productName: (id: string | null) => (id === PRODUCT ? "Gold plan" : null),
  userHref: (id: string) => `/users/${id}`,
  setting: { tenantId: TENANT, onSaved: vi.fn() },
  stale: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
});

describe("CustomersTab", () => {
  it("says the renewal rate and, beside it, how many are still open", () => {
    render(<CustomersTab {...props()} />);
    const tile = screen.getAllByText("analytics.customers.renewalRate")[0].closest("div")!.parentElement!;
    expect(within(tile).getAllByText("75%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/analytics\.customers\.renewalSplit:6,2,5/).length).toBeGreaterThan(0);
  });

  it("names a top customer and links them to their page", () => {
    render(<CustomersTab {...props()} />);
    // The table and its phone card both name them; both open the same page.
    const links = screen.getAllByRole("link", { name: "Sara" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(links.map(() => `/users/${USER}`));
  });

  it("lists no person to the platform's staff, and a hidden cell says why", () => {
    render(
      <CustomersTab
        {...props({
          customers: { ...customers, topCustomers: null, renewalByProduct: [{ productId: PRODUCT, people: "fewer_than_5" }], signups: { ...customers.signups, series: [null, null] } },
        })}
      />,
    );
    expect(screen.queryByText("analytics.customers.top.title")).toBeNull();
    expect(screen.getAllByText("analytics.catalog.fewerThan5").length).toBeGreaterThan(0);
  });

  it("saves a renewal window from 1 to 30 days, and refuses one outside it before asking", async () => {
    vi.mocked(setAnalyticsSettings).mockResolvedValue({ renewalWindowDays: 14 });
    const p = props();
    render(<CustomersTab {...p} />);
    const input = screen.getByLabelText("analytics.customers.window.label") as HTMLInputElement;
    const save = screen.getByRole("button", { name: "analytics.customers.window.save" });

    fireEvent.change(input, { target: { value: "31" } });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "14" } });
    fireEvent.click(save);
    await waitFor(() => expect(setAnalyticsSettings).toHaveBeenCalledWith(TENANT, { renewalWindowDays: 14 }));
    expect(p.setting?.onSaved).toHaveBeenCalled();
  });

  it("shows the setting only to whom may change it", () => {
    render(<CustomersTab {...props({ setting: null })} />);
    expect(screen.queryByLabelText("analytics.customers.window.label")).toBeNull();
    // The window the figures were judged by is still said.
    expect(screen.getAllByText(/analytics\.customers\.window\.current:7/).length).toBeGreaterThan(0);
  });
});

describe("renewalWindowEditable", () => {
  const me = (permissions: string[], type: "platform_owner" | "reseller" = "reseller") => ({ permissions, tenant: { type } });

  it("is billing's door: settings.manage on a reseller, platform.tenant.manage on the platform or a reseller's workspace, and a reseller's owner on its own", () => {
    expect(renewalWindowEditable(me(["settings.manage"]), {})).toBe(true);
    expect(renewalWindowEditable(me(["analytics.read"]), {})).toBe(false);
    expect(renewalWindowEditable(me(["settings.manage"], "platform_owner"), {})).toBe(false);
    expect(renewalWindowEditable(me(["platform.tenant.manage"], "platform_owner"), {})).toBe(true);
    expect(renewalWindowEditable(me([], "platform_owner"), { tenantId: TENANT, self: true })).toBe(true);
    expect(renewalWindowEditable(me(["platform.report.read"], "platform_owner"), { tenantId: TENANT })).toBe(false);
    expect(renewalWindowEditable(null, {})).toBe(false);
  });
});
