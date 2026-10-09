import { fireEvent, render, screen } from "@testing-library/react";
import { Suspense, type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { resellerUsersApi } from "@/lib/auth-api";
import { billingApi, resellerRevenueApi } from "@/lib/billing-api";
import { PANEL_USERS } from "@/lib/routes";
import { supportAgentApi } from "@/lib/support-api";
import { WIDGETS, startOfDayIn, visibleWidgets } from "./_lib/widgets";

/**
 * The staff's widgets (UX-1-r, `contract.ux.md` D5), each by the permission of
 * the page it links to, over APIs that already exist:
 *
 * - revenue: the caller's own tenant's, today / 7 / 30 days, from F-311-b's
 *   endpoint — a reseller's, or the platform's own for its staff (UX-1-r2);
 * - manual payments, the support queue (unassigned, mine, waiting), users (the
 *   total and a search that opens the users page), systems (platform only:
 *   panels by verdict).
 */

const D = FrontendI18nKeys.common.dashboard;
const VIEWS = FrontendI18nKeys.common.supportAgent.views;
const REVIEW = FrontendI18nKeys.common.systems.review;

let me: unknown = null;
const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${Object.values(vars).join("|")}` : key),
  }),
}));
vi.mock("./_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ me, group: { current: { userId: "u-1" }, members: [] }, timeZone: { zone: "Asia/Tehran" } }),
}));
vi.mock("@/lib/billing-api", () => ({ billingApi: { manualPayments: vi.fn(), systemsPanels: vi.fn() }, resellerRevenueApi: { totals: vi.fn() } }));
vi.mock("@/lib/support-api", () => ({ supportAgentApi: { inbox: vi.fn() } }));
vi.mock("@/lib/auth-api", () => ({ resellerUsersApi: { list: vi.fn() } }));

const NOW = new Date("2026-10-05T12:00:00Z"); // 15:30 in Tehran
const RESELLER_STAFF = { userId: "u-3", permissions: ["report.read", "user.read"], tenant: { id: "t-9", type: "reseller", isOwner: false } };
const PLATFORM_STAFF = { userId: "u-2", permissions: ["*"], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };

const STAFF = ["revenue", "manual-payments", "support-queue", "users", "systems"];
const widget = (id: string) => {
  const Body = WIDGETS.find((w) => w.id === id)!.component as unknown as ComponentType;
  return render(
    <Suspense fallback={null}>
      <Body />
    </Suspense>,
  );
};
const totals = (sales: string | null) => ({ currencyCode: "IRR", sales: { total: sales, count: 3 }, topUps: { total: "10.00", count: 1 } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  me = PLATFORM_STAFF;
});

describe("the registry (D5, D6)", () => {
  const ids = WIDGETS.map((w) => w.id);
  const seen = (gate: Partial<Parameters<typeof visibleWidgets>[1]>) =>
    visibleWidgets(WIDGETS, { held: [], tenantType: null, isOwner: false, menuIds: new Set(), ...gate })
      .map((w) => w.id)
      .filter((id) => STAFF.includes(id));

  it("puts the staff widgets after services and before support", () => {
    expect(ids.slice(ids.indexOf("services") + 1, ids.indexOf("support"))).toEqual(STAFF);
  });

  it("shows each by the page it links to; revenue to either tenant's staff, systems to the platform's", () => {
    expect(seen({ held: [], tenantType: "platform_owner", menuIds: new Set(["dashboard", "support"]) })).toEqual([]);
    const platformMenu = new Set(["manual-payments", "support-inbox", "users", "systems"]);
    expect(seen({ held: ["*"], tenantType: "platform_owner", menuIds: platformMenu })).toEqual(["revenue", "manual-payments", "support-queue", "users", "systems"]);
    expect(seen({ held: ["platform.report.read"], tenantType: "platform_owner", menuIds: new Set(["users"]) })).toEqual(["revenue", "users"]);
  });

  it("shows a reseller's staff the revenue widget by `report.read` (AC-1-e2)", () => {
    expect(seen({ held: ["report.read"], tenantType: "reseller", menuIds: new Set(["users"]) })).toEqual(["revenue", "users"]);
    expect(seen({ held: ["platform.report.read"], tenantType: "reseller", menuIds: new Set() })).toEqual([]);
  });
});

describe("the widgets (D5)", () => {
  it("revenue: the caller's own tenant today, 7 and 30 days, today from midnight in the caller's zone", async () => {
    me = RESELLER_STAFF;
    vi.mocked(resellerRevenueApi.totals).mockImplementation(async (_id, q) => totals(q.from ? "100.00" : "900.00") as never);
    widget("revenue");
    expect(await screen.findByText(D.revenue.today)).toBeTruthy();
    const calls = vi.mocked(resellerRevenueApi.totals).mock.calls;
    expect(calls.map(([id]) => id)).toEqual(["t-9", "t-9", "t-9"]);
    expect(calls[0][1]).toEqual({ from: "2026-10-04T20:30:00.000Z", to: NOW.toISOString() });
    expect(calls[1][1]).toEqual({ from: "2026-09-28T12:00:00.000Z", to: NOW.toISOString() });
    expect(calls[2][1]).toEqual({ from: "2026-09-05T12:00:00.000Z", to: NOW.toISOString() });
  });

  it("revenue: the platform's staff see the platform's own, users and resellers apart (UX-1-r2, UX-1-r3)", async () => {
    vi.mocked(resellerRevenueApi.totals).mockResolvedValue({
      ...totals("5.00"),
      fromResellers: { charged: { total: "7.00", count: 1 }, paidIn: { total: "20.00", count: 1 } },
    } as never);
    widget("revenue");
    await screen.findByText(D.revenue.today);
    expect(vi.mocked(resellerRevenueApi.totals).mock.calls.map(([id]) => id)).toEqual(["t-1", "t-1", "t-1"]);
    expect(screen.getAllByText(D.revenue.fromUsers)).toHaveLength(3);
    expect(screen.getAllByText(D.revenue.fromResellers)).toHaveLength(3);
  });

  it("revenue: a reseller's has no resellers line", async () => {
    me = RESELLER_STAFF;
    vi.mocked(resellerRevenueApi.totals).mockResolvedValue(totals("5.00") as never);
    widget("revenue");
    await screen.findByText(D.revenue.today);
    expect(screen.queryByText(D.revenue.fromResellers)).toBeNull();
  });

  it("support queue: unassigned, mine and waiting, a full first page as 50+", async () => {
    vi.mocked(supportAgentApi.inbox).mockImplementation(async (view) => {
      if (view === "unassigned") return { items: new Array(50).fill({}), nextAfter: "x" } as never;
      if (view === "mine") return { items: new Array(2).fill({}), nextAfter: null } as never;
      return { items: [], nextAfter: null } as never;
    });
    widget("support-queue");
    expect((await screen.findByText(VIEWS.unassigned)).parentElement?.textContent).toContain("50+");
    expect(screen.getByText(VIEWS.mine).parentElement?.textContent).toContain("2");
    expect(screen.getByText(VIEWS.pending).parentElement?.textContent).toContain("0");
    expect(vi.mocked(supportAgentApi.inbox).mock.calls.map(([v]) => v).sort()).toEqual(["mine", "pending", "unassigned"]);
  });

  it("users: the total, and a search that opens the users page", async () => {
    vi.mocked(resellerUsersApi.list).mockResolvedValue({ items: [], total: 1234, page: 1, pageSize: 1 } as never);
    widget("users");
    expect(await screen.findByText(/1,234|1234/)).toBeTruthy();
    expect(vi.mocked(resellerUsersApi.list)).toHaveBeenCalledWith("t-1", { page: 1, pageSize: 1 });
    fireEvent.change(screen.getByRole("searchbox", { name: D.users.search }), { target: { value: "sara" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(push).toHaveBeenCalledWith(`${PANEL_USERS}?q=sara`);
  });

  it("systems: panels in service counted by verdict", async () => {
    const panel = (reviewState: string, retiredAt: string | null = null) => ({ review: { reviewState }, retiredAt });
    vi.mocked(billingApi.systemsPanels).mockResolvedValue([
      panel("accepted"),
      panel("accepted"),
      panel("refused"),
      panel("accepted", "2026-01-01T00:00:00Z"),
    ] as never);
    widget("systems");
    expect((await screen.findByText(REVIEW.accepted)).parentElement?.textContent).toContain("2");
    expect(screen.getByText(REVIEW.refused).parentElement?.textContent).toContain("1");
    expect(screen.queryByText(REVIEW.pending)).toBeNull();
  });

  it("manual payments: how many wait for a person", async () => {
    vi.mocked(billingApi.manualPayments).mockResolvedValue(new Array(3).fill({ status: "pending" }) as never);
    widget("manual-payments");
    expect(await screen.findByText(`${D.manualPayments.waiting}|3`)).toBeTruthy();
  });

  it("finds a day's start in a zone", () => {
    expect(startOfDayIn(NOW, "Asia/Tehran").toISOString()).toBe("2026-10-04T20:30:00.000Z");
    expect(startOfDayIn(NOW, "UTC").toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });
});
