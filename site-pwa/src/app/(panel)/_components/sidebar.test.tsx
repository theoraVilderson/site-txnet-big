import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { supportAgentApi, supportApi } from "@/lib/support-api";
import { billingApi } from "@/lib/billing-api";
import {
  MENU_SECTIONS,
  PANEL_MENU,
  badgeLabel,
  isMenuGroup,
  menuFooter,
  menuSections,
  visibleMenu,
} from "../_lib/panel-menu";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { DEFAULT_UI_PREFERENCES, useUiPreferences } from "@/stores/ui-preferences-store";
import { PanelSidebar } from "./PanelSidebar";

/**
 * The sectioned sidebar (UX-1-j, `contract.ux.md` N1–N4):
 *
 * - six sections, in N1's order, each entry in the one N1 names; settings sits
 *   in the footer, not in a section;
 * - a section with nothing visible is not drawn, and a caller who sees only
 *   `account` sees no headings at all;
 * - a section folds from its heading, and the fold is the person's (UX-1-m);
 * - collapsed, a group opens a flyout beside it instead of widening the rail;
 * - support, the support inbox and manual payments carry a count, 1–9 then 9+.
 */

const S = FrontendI18nKeys.common.shell;

let pathname = "/";
let me: unknown = null;
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars?.count !== undefined ? `${vars.label} ${key}:${vars.count}` : key) }),
}));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me, group: { current: { userId: "u-1" } } }) }));
vi.mock("../_context/PanelRealtimeContext", () => ({ usePanelRealtime: () => null }));
vi.mock("./ResellerWorkspaceNav", () => ({ OtherResellers: () => null, HandoffAction: () => null }));
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
// A fold or a pin is written 600ms later (UX-1-l): answered, so a slow run never sees it rolled back.
// (The defaults inline: importing the store here would import this module back.)
vi.mock("@/lib/auth-api", () => {
  const defaults = { "ui.motion": "system", "ui.dashboard": { order: [], hidden: [] }, "ui.pins": [], "ui.sidebar": { collapsed: false, closedSections: [] } };
  return { authApi: { uiPreferences: vi.fn(async () => defaults), saveUiPreferences: vi.fn(async (patch: object) => ({ ...defaults, ...patch })) } };
});

const USER = { permissions: [], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };
const STAFF = { permissions: ["*"], tenant: { id: "t-1", type: "platform_owner", isOwner: true } };

const sectionOf = (id: string) => PANEL_MENU.find((e) => e.id === id || (isMenuGroup(e) && e.children.some((c) => c.id === id)))?.section;

beforeEach(() => {
  vi.clearAllMocks();
  pathname = "/";
  me = USER;
  localStorage.clear();
  usePanelUiStore.setState({ drawerOpen: false, openGroupId: null });
  useUiPreferences.getState().reset();
  window.matchMedia = ((query: string) => ({ matches: query.includes("min-width"), addEventListener() {}, removeEventListener() {} })) as never;
  vi.mocked(supportApi.list).mockResolvedValue({ items: [], nextBefore: null });
  vi.mocked(supportAgentApi.inbox).mockResolvedValue({ items: [], nextAfter: null });
  vi.mocked(billingApi.manualPayments).mockResolvedValue([]);
});

describe("the menu's sections (N1)", () => {
  it("are the six of N1, in its order", () => {
    expect(MENU_SECTIONS.map((s) => s.id)).toEqual(["account", "sales", "finance", "people", "infra", "support"]);
  });

  it.each([
    ["account", ["dashboard", "buy", "my-services", "wallet", "wheel", "lotteries", "support", "buy-reseller"]],
    ["sales", ["analytics", "catalog", "coupons", "ai", "wheel-settings", "lottery-settings"]],
    ["finance", ["gateways", "manual-payments", "tenant-billing"]],
    ["people", ["users", "groups", "resellers"]],
    ["infra", ["systems", "release-flags"]],
    ["support", ["support-inbox", "support-settings", "guides"]],
  ])("puts in %s exactly what N1 names, in order", (section, ids) => {
    const all = visibleMenu(PANEL_MENU, ["*"], "platform_owner", false, false, "t-1").concat(
      visibleMenu(PANEL_MENU, ["*"], "reseller", true, false, "t-1").filter((e) => e.id === "tenant-billing"),
    );
    const found = menuSections(all).find((s) => s.id === section)?.entries.map((e) => e.id);
    expect(found).toEqual(ids);
  });

  it("keeps the wallet's pages and the resellers' three under their groups, packages and limits included", () => {
    const wallet = PANEL_MENU.find((e) => e.id === "wallet");
    const resellers = PANEL_MENU.find((e) => e.id === "resellers");
    expect(wallet && isMenuGroup(wallet) && wallet.children.map((c) => c.id)).toEqual(["financial-history", "deposit"]);
    expect(resellers && isMenuGroup(resellers) && resellers.children.map((c) => c.id)).toEqual(["reseller-list", "reseller-packages", "reseller-limits"]);
    expect(sectionOf("settings")).toBe("footer");
  });

  it("puts settings in the footer and nowhere else", () => {
    const visible = visibleMenu(PANEL_MENU, [], "platform_owner", false, false, null);
    expect(menuFooter(visible).map((e) => e.id)).toEqual(["settings"]);
    expect(menuSections(visible).flatMap((s) => s.entries).some((e) => e.id === "settings")).toBe(false);
  });

  it("draws no section with nothing visible", () => {
    const sections = menuSections(visibleMenu(PANEL_MENU, [], "platform_owner", false, false, null));
    expect(sections.map((s) => s.id)).toEqual(["account"]);
  });
});

describe("badgeLabel (N4)", () => {
  it("is nothing at zero, the count to 9, then 9+", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(null)).toBeNull();
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("9+");
  });
});

describe("PanelSidebar", () => {
  it("shows no section heading to a caller who sees only account", () => {
    render(<PanelSidebar />);
    expect(screen.queryByRole("button", { name: S.sections.account })).toBeNull();
    expect(screen.getByRole("link", { name: S.menu.dashboard })).toBeInTheDocument();
  });

  it("folds a section from its heading, and keeps the fold in the person's preferences", async () => {
    me = STAFF;
    const { unmount } = render(<PanelSidebar />);
    const heading = screen.getByRole("button", { name: S.sections.sales });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: S.menu.catalog })).toBeInTheDocument();

    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    // UX-1-m: the fold is `ui.sidebar.closedSections`, not this device's.
    expect(useUiPreferences.getState().prefs["ui.sidebar"].closedSections).toEqual(["sales"]);
    await waitFor(() => expect(screen.queryByRole("link", { name: S.menu.catalog })).toBeNull());
    unmount();

    useUiPreferences.setState({ prefs: { ...DEFAULT_UI_PREFERENCES, "ui.sidebar": { collapsed: false, closedSections: ["sales"] } } });
    render(<PanelSidebar />);
    expect(screen.getByRole("button", { name: S.sections.sales })).toHaveAttribute("aria-expanded", "false");
  });

  it("collapsed, opens a group as a flyout beside the rail rather than widening it", async () => {
    me = STAFF;
    // The collapse is the person's `ui.sidebar.collapsed` (UX-1-l).
    useUiPreferences.setState({ prefs: { ...DEFAULT_UI_PREFERENCES, "ui.sidebar": { collapsed: true, closedSections: [] } } });
    render(<PanelSidebar />);
    fireEvent.click(screen.getByRole("button", { name: S.menu.wallet }));

    expect(useUiPreferences.getState().prefs["ui.sidebar"].collapsed).toBe(true);
    const flyout = await screen.findByRole("dialog", { name: S.menu.wallet });
    expect(within(flyout).getByRole("link", { name: S.menu.deposit })).toBeInTheDocument();
  });

  it("collapsed, still scrolls, so settings and logout stay on a short screen", () => {
    useUiPreferences.setState({ prefs: { ...DEFAULT_UI_PREFERENCES, "ui.sidebar": { collapsed: true, closedSections: [] } } });
    render(<PanelSidebar />);
    const nav = screen.getByRole("navigation", { name: S.navigation });
    expect(nav.className).toContain("overflow-y-auto");
    expect(nav.className).not.toContain("overflow-visible");

    // The tooltip is drawn outside the scroll box, so scrolling cannot clip it.
    const link = within(nav).getAllByRole("link")[0];
    fireEvent.pointerEnter(link);
    const tip = screen.getAllByText(link.textContent ?? "").find((el) => el.getAttribute("aria-hidden") !== null);
    expect(tip).toBeDefined();
    expect(nav.contains(tip ?? null)).toBe(false);
    fireEvent.pointerLeave(link);
    expect(tip).not.toBeInTheDocument();
  });

  it("counts unread support, the unassigned queue and open manual payments, 9+ past nine", async () => {
    me = STAFF;
    vi.mocked(supportApi.list).mockResolvedValue({ items: [{ unread: 2 }, { unread: 1 }, { unread: 0 }], nextBefore: null } as never);
    vi.mocked(supportAgentApi.inbox).mockResolvedValue({ items: Array.from({ length: 12 }, () => ({})), nextAfter: null } as never);
    vi.mocked(billingApi.manualPayments).mockResolvedValue([{}, {}] as never);
    render(<PanelSidebar />);

    // The name carries the count in words (`shell.badge`); the drawn number is decorative.
    const badge = (label: string) => {
      const link = screen.getByRole("link", { name: new RegExp(`^${label.replace(/\./g, "\\.")} ${S.badge.replace(/\./g, "\\.")}:`) });
      return within(link).getByText(/^\d\+?$/).textContent;
    };
    await waitFor(() => expect(badge(S.menu.support)).toBe("3"));
    expect(badge(S.menu.supportInbox)).toBe("9+");
    expect(badge(S.menu.manualPayments)).toBe("2");
    expect(supportAgentApi.inbox).toHaveBeenCalledWith("unassigned");
  });

  it("asks a caller without the inbox's permission for no inbox count", async () => {
    render(<PanelSidebar />);
    await act(async () => {});
    expect(supportApi.list).toHaveBeenCalled();
    expect(supportAgentApi.inbox).not.toHaveBeenCalled();
    expect(billingApi.manualPayments).not.toHaveBeenCalled();
  });
});
