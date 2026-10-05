import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { DEFAULT_UI_PREFERENCES, useUiPreferences } from "@/stores/ui-preferences-store";
import { MAX_PINS } from "../_lib/pins";
import { RECENT_PAGES_KEY, readRecentPages, recordRecentPage } from "../_lib/recent-pages";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { PanelSidebar } from "./PanelSidebar";

/**
 * Pins, folds and recent pages (UX-1-m, `contract.ux.md` N2, N5):
 *
 * - an entry's own menu pins it to a "pinned" block at the top, and unpins it;
 *   the pins are the person's `ui.pins`, at most 8, in the order they keep;
 * - pinned entries move by up/down buttons (drag is the same write);
 * - a pinned entry the caller may not open is not drawn;
 * - a folded section is the person's `ui.sidebar.closedSections`, written
 *   beside the collapse it already holds;
 * - recent pages are this device's last 10, newest first, never the server.
 */

const S = FrontendI18nKeys.common.shell;

let pathname = "/";
let me: unknown = null;
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars?.label !== undefined ? `${key}|${vars.label}` : key),
  }),
}));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me, group: { current: { userId: "u-1" } } }) }));
vi.mock("../_context/PanelRealtimeContext", () => ({ usePanelRealtime: () => null }));
vi.mock("./ResellerPanelButton", () => ({ ResellerPanelButton: () => null, useOwnedResellers: () => [] }));
vi.mock("./LogoutButton", () => ({ LogoutButton: () => null }));
vi.mock("@auth/auth/_components/LangDropdown", () => ({ LangDropdown: () => null }));
vi.mock("@auth/auth/_components/ThemeDropdown", () => ({ ThemeDropdown: () => null }));
vi.mock("@/components/BrandMark", () => ({ BrandMark: () => null }));
vi.mock("@/lib/tenant-api", () => ({
  resellerPurchaseApi: { mine: vi.fn(async () => ({ reseller: null })) },
  tenantAccessApi: { get: vi.fn(async () => ({ canRead: false })) },
}));
vi.mock("@/lib/support-api", () => ({
  supportApi: { list: vi.fn(async () => ({ items: [], nextBefore: null })) },
  supportAgentApi: { inbox: vi.fn(async () => ({ items: [], nextAfter: null })) },
}));
vi.mock("@/lib/billing-api", () => ({ billingApi: { manualPayments: vi.fn(async () => []) } }));

const USER = { permissions: [], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };
const STAFF = { permissions: ["*"], tenant: { id: "t-1", type: "platform_owner", isOwner: true } };

const pins = () => useUiPreferences.getState().prefs["ui.pins"];
const withPins = (ids: string[]) => useUiPreferences.setState({ prefs: { ...DEFAULT_UI_PREFERENCES, "ui.pins": ids } });
const pinnedBlock = () => screen.getByRole("list", { name: S.sections.pinned });

beforeEach(() => {
  vi.clearAllMocks();
  pathname = "/";
  me = USER;
  localStorage.clear();
  usePanelUiStore.setState({ drawerOpen: false, openGroupId: null });
  useUiPreferences.getState().reset();
  window.matchMedia = ((query: string) => ({ matches: query.includes("min-width"), addEventListener() {}, removeEventListener() {} })) as never;
});

describe("pins (N5)", () => {
  it("draws no pinned block while nothing is pinned", () => {
    render(<PanelSidebar />);
    expect(screen.queryByRole("list", { name: S.sections.pinned })).toBeNull();
  });

  it("pins an entry from its own menu into ui.pins, and the block shows it", async () => {
    render(<PanelSidebar />);
    fireEvent.click(screen.getByRole("button", { name: `${S.pins.actions}|${S.menu.wheel}` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: S.pins.pin }));

    expect(pins()).toEqual(["wheel"]);
    expect(within(pinnedBlock()).getByRole("link", { name: S.menu.wheel })).toBeInTheDocument();
  });

  it("unpins from the same menu, and the block goes", async () => {
    withPins(["wheel"]);
    render(<PanelSidebar />);
    const [trigger] = within(pinnedBlock()).getAllByRole("button", { name: `${S.pins.actions}|${S.menu.wheel}` });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: S.pins.unpin }));

    expect(pins()).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("list", { name: S.sections.pinned })).toBeNull());
  });

  it("pins a page inside a group, by its own id", async () => {
    withPins(["deposit"]);
    render(<PanelSidebar />);
    expect(within(pinnedBlock()).getByRole("link", { name: S.menu.deposit })).toBeInTheDocument();
  });

  it("draws the pins in the order kept, and moves one by its up and down buttons", () => {
    withPins(["wheel", "support", "lotteries"]);
    render(<PanelSidebar />);
    const names = () => within(pinnedBlock()).getAllByRole("link").map((l) => l.textContent);
    expect(names()).toEqual([S.menu.wheel, S.menu.support, S.menu.lotteries]);

    // The first has no way up and the last no way down.
    expect(within(pinnedBlock()).queryByRole("button", { name: `${S.pins.moveUp}|${S.menu.wheel}` })).toBeNull();
    expect(within(pinnedBlock()).queryByRole("button", { name: `${S.pins.moveDown}|${S.menu.lotteries}` })).toBeNull();

    fireEvent.click(within(pinnedBlock()).getByRole("button", { name: `${S.pins.moveDown}|${S.menu.wheel}` }));
    expect(pins()).toEqual(["support", "wheel", "lotteries"]);
    fireEvent.click(within(pinnedBlock()).getByRole("button", { name: `${S.pins.moveUp}|${S.menu.lotteries}` }));
    expect(pins()).toEqual(["support", "lotteries", "wheel"]);
  });

  it("refuses a ninth pin: the menu item is disabled and says why", async () => {
    const eight = ["dashboard", "buy", "my-services", "financial-history", "deposit", "lotteries", "support", "settings"];
    expect(eight).toHaveLength(MAX_PINS);
    withPins(eight);
    render(<PanelSidebar />);
    fireEvent.click(screen.getByRole("button", { name: `${S.pins.actions}|${S.menu.wheel}` }));
    expect(await screen.findByRole("menuitem", { name: S.pins.full })).toBeDisabled();
    expect(pins()).toEqual(eight);
  });

  it("never draws a pin the caller may not open, and keeps it in ui.pins", () => {
    withPins(["catalog", "wheel"]);
    render(<PanelSidebar />);
    expect(within(pinnedBlock()).getAllByRole("link").map((l) => l.textContent)).toEqual([S.menu.wheel]);
    expect(pins()).toEqual(["catalog", "wheel"]);
  });

  it("moves a visible pin past a hidden one without losing the hidden one", () => {
    withPins(["wheel", "catalog", "support"]);
    render(<PanelSidebar />);
    fireEvent.click(within(pinnedBlock()).getByRole("button", { name: `${S.pins.moveDown}|${S.menu.wheel}` }));
    expect(pins().filter((id) => id !== "catalog")).toEqual(["support", "wheel"]);
    expect(pins()).toContain("catalog");
  });
});

describe("folded sections (N2)", () => {
  it("are the person's ui.sidebar.closedSections, written beside the collapse", () => {
    me = STAFF;
    useUiPreferences.setState({ prefs: { ...DEFAULT_UI_PREFERENCES, "ui.sidebar": { collapsed: true, closedSections: [] } } });
    render(<PanelSidebar />);
    fireEvent.click(screen.getByRole("button", { name: S.sections.sales }));
    expect(useUiPreferences.getState().prefs["ui.sidebar"]).toEqual({ collapsed: true, closedSections: ["sales"] });
  });

  it("render folded from the saved preference, with nothing on this device", () => {
    me = STAFF;
    useUiPreferences.setState({ prefs: { ...DEFAULT_UI_PREFERENCES, "ui.sidebar": { collapsed: false, closedSections: ["sales"] } } });
    render(<PanelSidebar />);
    expect(screen.getByRole("button", { name: S.sections.sales })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: S.menu.catalog })).toBeNull();
  });
});

describe("recent pages (N5)", () => {
  it("keeps the last 10, newest first, one row per path", () => {
    for (let i = 0; i < 12; i++) recordRecentPage({ href: `/p${i}`, id: "wheel" });
    recordRecentPage({ href: "/p5", id: "wheel" });
    const recent = readRecentPages();
    expect(recent).toHaveLength(10);
    expect(recent[0].href).toBe("/p5");
    expect(recent.filter((r) => r.href === "/p5")).toHaveLength(1);
    expect(recent.map((r) => r.href)).not.toContain("/p0");
  });

  it("lives on this device only, and survives storage that refuses", () => {
    recordRecentPage({ href: "/wheel", id: "wheel" });
    expect(JSON.parse(localStorage.getItem(RECENT_PAGES_KEY) ?? "[]")[0].href).toBe("/wheel");
    localStorage.setItem(RECENT_PAGES_KEY, "{not json");
    expect(readRecentPages()).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => recordRecentPage({ href: "/x", id: "wheel" })).not.toThrow();
    spy.mockRestore();
  });

  it("is written by the sidebar when the caller lands on a menu page", async () => {
    pathname = "/wheel";
    render(<PanelSidebar />);
    await act(async () => {});
    expect(readRecentPages()[0]).toEqual({ href: "/wheel", id: "wheel" });
    expect(useUiPreferences.getState().pending).toEqual({});
  });
});
