import { existsSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { resellerMenu, workspaceOfPath } from "../_lib/reseller-menu";
import { clearOwnedResellersCache } from "../my-resellers/_lib/workspace";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { DEFAULT_UI_PREFERENCES, useUiPreferences } from "@/stores/ui-preferences-store";
import { ResellerWorkspaceProvider } from "../_context/ResellerWorkspaceContext";
import { PanelSidebar } from "./PanelSidebar";

const renderSidebar = () =>
  render(
    <ResellerWorkspaceProvider>
      <PanelSidebar />
    </ResellerWorkspaceProvider>,
  );

/**
 * One menu for the account and its reseller (UX-2-a, `contract.reseller-workspace.md`;
 * user, 2026-10-08: merged into the sections, not a switcher). The reseller's
 * pages join the account menu's sections — catalog under sales, gateways under
 * finance, users under people, domains and bot under infra, home, settings and
 * brand under account with the handoff after them — on both hosts. Whose
 * reseller: the address's, else the caller's own; nothing is stored. It
 * replaced the sidebar's reseller block and the N8 tab bar.
 */

const N = FrontendI18nKeys.common.resellerNav;
const S = FrontendI18nKeys.common.shell;

let pathname = "/";
let me: unknown = null;
// The setup row and its reads are UX-2-e's (`my-resellers/setup-progress.test.tsx`).
vi.mock("../_hooks/useResellerSetup", () => ({ useResellerSetup: () => ({ setup: null, reread: () => undefined }) }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key }),
}));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me, isLoading: false, group: { current: { userId: "u-1" } } }) }));
vi.mock("../_context/PanelRealtimeContext", () => ({ usePanelRealtime: () => null }));
vi.mock("./LogoutButton", () => ({ LogoutButton: () => null }));
vi.mock("@auth/auth/_components/LangDropdown", () => ({ LangDropdown: () => null }));
vi.mock("@auth/auth/_components/ThemeDropdown", () => ({ ThemeDropdown: () => null }));
vi.mock("@/components/BrandMark", () => ({ BrandMark: () => null }));
vi.mock("@/lib/tenant-api", () => ({
  resellerPurchaseApi: { mine: vi.fn(async () => ({ reseller: null })) },
  tenantAccessApi: { get: vi.fn(async () => ({ canRead: true })) },
}));
vi.mock("@/lib/support-api", () => ({
  supportApi: { list: vi.fn(async () => ({ items: [], nextBefore: null })) },
  supportAgentApi: { inbox: vi.fn(async () => ({ items: [], nextAfter: null })) },
}));
vi.mock("@/lib/billing-api", () => ({ billingApi: { manualPayments: vi.fn(async () => []) } }));
let owned: unknown[] = [];
const issueHandoff = vi.fn();
vi.mock("@/lib/auth-api", () => {
  const defaults = { "ui.motion": "system", "ui.dashboard": { order: [], hidden: [] }, "ui.pins": [], "ui.sidebar": { collapsed: false, closedSections: [] } };
  return {
    authApi: {
      uiPreferences: vi.fn(async () => defaults),
      saveUiPreferences: vi.fn(async (patch: object) => ({ ...defaults, ...patch })),
      ownedResellers: vi.fn(async () => ({ resellers: owned })),
      issueHandoff: (id: string) => issueHandoff(id),
    },
  };
});

const OWNER = { userId: "u-1", permissions: [], tenant: { id: "t-platform", type: "platform_owner", isOwner: false } };
const STAFF = { userId: "u-2", permissions: ["*"], tenant: { id: "t-platform", type: "platform_owner", isOwner: true } };
const ON_DOMAIN = { userId: "u-3", permissions: [], tenant: { id: "r-1", type: "reseller", isOwner: true } };
const ARIAN = { id: "r-1", slug: "arian", here: false, hasPanel: true, live: true };

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  clearOwnedResellersCache();
  pathname = "/";
  me = OWNER;
  owned = [ARIAN];
  localStorage.clear();
  usePanelUiStore.setState({ drawerOpen: false, openGroupId: null });
  useUiPreferences.getState().reset();
  window.matchMedia = ((query: string) => ({ matches: query.includes("min-width"), addEventListener() {}, removeEventListener() {} })) as never;
  Object.defineProperty(window, "location", { value: { assign }, writable: true });
  issueHandoff.mockResolvedValue({ origin: "https://arianvpn.ir", code: "c0de", expiresIn: 60 });
});

describe("workspaceOfPath — the address picks the menu", () => {
  it.each([
    ["/reseller", { id: "r-1", self: true }],
    ["/reseller/gateways", { id: "r-1", self: true }],
    ["/my-resellers/r-9/users/u-1", { id: "r-9", self: false }],
    ["/", null],
    // Whole segments only: the platform's resellers list is not a workspace.
    ["/resellers/buy", null],
    ["/resellerships", null],
  ])("%s", (path, expected) => {
    expect(workspaceOfPath(path, OWNER as never, "r-1")).toEqual(expected);
  });

  it("is no workspace at the platform's own users page, which shares the address", () => {
    expect(workspaceOfPath("/my-resellers/t-platform/users", STAFF as never, null)).toBeNull();
  });

  it("is none at /reseller for a caller with no reseller of their own, and unknown while that is", () => {
    expect(workspaceOfPath("/reseller", OWNER as never, null)).toBeNull();
    expect(workspaceOfPath("/reseller", OWNER as never, undefined)).toBeNull();
  });
});

describe("the reseller's links", () => {
  it("are one group in the account section, its pages in working order, by id or with none", () => {
    const byId = resellerMenu({ id: "r-9", self: false });
    expect(byId).toMatchObject({ id: "reseller", section: "account" });
    expect(byId.children.map((l) => l.href)).toEqual([
      "/my-resellers/r-9",
      "/my-resellers/r-9/catalog",
      "/my-resellers/r-9/gateways",
      "/my-resellers/r-9/users",
      "/my-resellers/r-9/team",
      "/my-resellers/r-9/roles",
      "/my-resellers/r-9/domains",
      "/my-resellers/r-9/bot",
      "/my-resellers/r-9/branding",
      "/my-resellers/r-9/settings",
    ]);
    const self = resellerMenu({ id: "r-1", self: true }).children.map((l) => l.href);
    expect(self).toEqual(byId.children.map((l) => l.href.replace("/my-resellers/r-9", "/reseller")));
  });

  it("link only pages that exist, at both addresses", () => {
    const app = join(__dirname, "..");
    const missing = resellerMenu({ id: "ID", self: false })
      .children.flatMap((e) => [e.href.replace("/my-resellers/ID", "my-resellers/[id]"), e.href.replace("/my-resellers/ID", "reseller")])
      .filter((dir) => !existsSync(join(app, dir, "page.tsx")));
    expect(missing).toEqual([]);
  });
});

/** The list a section heading folds. */
const sectionList = (label: string) => document.getElementById(screen.getByRole("button", { name: label }).getAttribute("aria-controls")!)!;

/** The one "reseller" button (user, 2026-10-08: one entry that opens, not links spread over the sections). */
const resellerButton = () => screen.findByRole("button", { name: (n) => n === N.groupLabel || n === N.scope });

describe("one reseller button that opens", () => {
  it("is closed in my account, names the reseller once, and opens to its pages", async () => {
    renderSidebar();
    const button = await resellerButton();
    expect(button).toHaveAttribute("aria-expanded", "false");
    // Named once, on the button — not on every page under it.
    expect(screen.getAllByText("arian")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: N.short.catalog })).toBeNull();

    fireEvent.click(button);
    const pages = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(await within(pages).findByRole("link", { name: N.short.catalog })).toHaveAttribute("href", "/reseller/catalog");
    expect(within(pages).getByRole("link", { name: N.short.home })).toHaveAttribute("href", "/reseller");
    // The handoff belongs to the reseller: inside, after its pages.
    expect(within(pages).getByRole("button", { name: N.open })).toBeInTheDocument();
    // Nowhere else in the menu.
    expect(screen.getAllByRole("link", { name: N.short.catalog })).toHaveLength(1);
  });

  it("is open by itself on a reseller page, that page current", async () => {
    pathname = "/reseller/domains";
    renderSidebar();
    expect(await screen.findByRole("link", { name: N.short.domains })).toHaveAttribute("aria-current", "page");
    expect(await resellerButton()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: S.menu.dashboard })).not.toHaveAttribute("aria-current");
  });

  it("follows the id in the address for staff opening another reseller", async () => {
    me = STAFF;
    owned = [];
    pathname = "/my-resellers/r-9/catalog";
    renderSidebar();
    expect(await screen.findByRole("link", { name: N.short.catalog })).toHaveAttribute("href", "/my-resellers/r-9/catalog");
    // Not theirs: no handoff to offer.
    expect(screen.queryByRole("button", { name: N.open })).toBeNull();
  });

  it("lets an owner holding a terminated reseller beside the live one pick which", async () => {
    owned = [ARIAN, { id: "r-0", slug: "old", here: false, hasPanel: false, live: false }];
    pathname = "/my-resellers/r-0/domains";
    renderSidebar();
    const list = await screen.findByRole("list", { name: N.others });
    expect(within(list).getByRole("link", { name: "old" })).toHaveAttribute("aria-current", "true");
    expect(within(list).getByRole("link", { name: "arian" })).toHaveAttribute("href", "/reseller");
    expect(screen.getByRole("link", { name: N.short.domains })).toHaveAttribute("href", "/my-resellers/r-0/domains");
  });

  it("is not there for a caller with no reseller", async () => {
    owned = [];
    renderSidebar();
    await waitFor(() => expect(screen.getByRole("link", { name: S.menu.dashboard })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: (n) => n === N.groupLabel || n === N.scope })).toBeNull();
  });

  // `tenant.manage` is retired (AC-1-d); AC-1-e2 gives a seat its pages by its own keys and turns this back on.
  it.skip("AC-1-e2: draws a reseller staff seat's users once, where the account menu has it", async () => {
    me = { ...ON_DOMAIN, permissions: ["tenant.manage"], tenant: { ...ON_DOMAIN.tenant, isOwner: false } };
    owned = [];
    renderSidebar();
    // The account's own users page arrives a moment later and redraws the menu: click after it.
    await waitFor(() => expect(screen.getByRole("link", { name: S.menu.users })).toHaveAttribute("href", "/users"));
    fireEvent.click(await resellerButton());
    expect(await screen.findByRole("link", { name: N.short.catalog })).toHaveAttribute("href", "/reseller/catalog");
    expect(screen.queryByRole("link", { name: N.short.users })).toBeNull();
  });

  it("keeps the full label where the button is not around it — a pinned page", async () => {
    useUiPreferences.setState({ prefs: { ...DEFAULT_UI_PREFERENCES, "ui.pins": ["reseller-domains"] } });
    renderSidebar();
    expect(await screen.findByRole("link", { name: N.menu.domains })).toHaveAttribute("href", "/reseller/domains");
  });
});

describe("the handoff, after the reseller's links", () => {
  it("opens the owner's panel on its domain, from the platform", async () => {
    pathname = "/reseller";
    renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: N.open }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://arianvpn.ir/auth/handoff#c0de"));
  });

  it("is disabled where it would be refused, and says why", async () => {
    owned = [{ ...ARIAN, hasPanel: false }];
    pathname = "/reseller";
    renderSidebar();
    expect(await screen.findByRole("button", { name: N.open })).toBeDisabled();
    expect(screen.getByText(N.noPanel)).toBeInTheDocument();
  });

  it("is not offered on the reseller's own domain, where there is nowhere to hand off to", async () => {
    me = ON_DOMAIN;
    owned = [];
    pathname = "/reseller/bot";
    renderSidebar();
    expect(await screen.findByRole("link", { name: N.short.bot })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: N.open })).toBeNull();
  });
});
