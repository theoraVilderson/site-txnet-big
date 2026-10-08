import { existsSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RESELLER_SECTIONS, resellerMenu, workspaceOfPath } from "../_lib/reseller-menu";
import { clearOwnedResellersCache } from "../my-resellers/_lib/workspace";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { useUiPreferences } from "@/stores/ui-preferences-store";
import { PanelSidebar } from "./PanelSidebar";

/**
 * The workspace switcher (UX-2-a, `contract.reseller-workspace.md`): at the
 * top of the sidebar, "my account" / "my reseller". Nothing is stored — the
 * address picks the menu: inside `/reseller/…` or `/my-resellers/:id/…` the
 * sidebar draws the reseller's own sectioned menu, with the handoff in it, on
 * both hosts. It replaced the sidebar's reseller block and the N8 tab bar.
 */

const N = FrontendI18nKeys.common.resellerNav;
const S = FrontendI18nKeys.common.shell;

let pathname = "/";
let me: unknown = null;
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

describe("the reseller menu", () => {
  it("has the six sections, in order, each with its pages, by id or with none", () => {
    expect(RESELLER_SECTIONS.map((s) => s.id)).toEqual(["home", "sales", "finance", "customers", "infra", "settings"]);
    const byId = resellerMenu({ id: "r-9", self: false });
    expect(byId.map((s) => [s.id, s.entries.map((e) => e.href)])).toEqual([
      ["home", ["/my-resellers/r-9"]],
      ["sales", ["/my-resellers/r-9/catalog"]],
      ["finance", ["/my-resellers/r-9/gateways"]],
      ["customers", ["/my-resellers/r-9/users"]],
      ["infra", ["/my-resellers/r-9/domains", "/my-resellers/r-9/bot"]],
      ["settings", ["/my-resellers/r-9/settings", "/my-resellers/r-9/branding"]],
    ]);
    const self = resellerMenu({ id: "r-1", self: true }).flatMap((s) => s.entries.map((e) => e.href));
    expect(self).toEqual(byId.flatMap((s) => s.entries.map((e) => e.href.replace("/my-resellers/r-9", "/reseller"))));
  });

  it("links only pages that exist, at both addresses", () => {
    const app = join(__dirname, "..");
    const missing = resellerMenu({ id: "ID", self: false })
      .flatMap((s) => s.entries)
      .flatMap((e) => [e.href.replace("/my-resellers/ID", "my-resellers/[id]"), e.href.replace("/my-resellers/ID", "reseller")])
      .filter((dir) => !existsSync(join(app, dir, "page.tsx")));
    expect(missing).toEqual([]);
  });
});

describe("the switcher", () => {
  it("draws the account's menu outside a workspace, with my reseller one tap away", async () => {
    render(<PanelSidebar />);
    const switcher = await screen.findByRole("navigation", { name: N.switcher.label });
    expect(within(switcher).getByRole("link", { name: N.switcher.account })).toHaveAttribute("aria-current", "true");
    expect(within(switcher).getByRole("link", { name: N.switcher.reseller })).toHaveAttribute("href", "/reseller");
    expect(screen.getByRole("link", { name: S.menu.dashboard })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: N.menu.catalog })).toBeNull();
  });

  it("draws the reseller's sectioned menu inside it, and not the account's", async () => {
    pathname = "/reseller/domains";
    render(<PanelSidebar />);
    const switcher = await screen.findByRole("navigation", { name: N.switcher.label });
    expect(within(switcher).getByRole("link", { name: N.switcher.reseller })).toHaveAttribute("aria-current", "true");
    expect(await screen.findByRole("link", { name: N.menu.domains })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: N.menu.home })).toHaveAttribute("href", "/reseller");
    expect(screen.getByRole("button", { name: N.sections.infra })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: S.menu.dashboard })).toBeNull();
  });

  it("follows the id in the address for staff opening another reseller", async () => {
    me = STAFF;
    owned = [];
    pathname = "/my-resellers/r-9/catalog";
    render(<PanelSidebar />);
    expect(await screen.findByRole("link", { name: N.menu.catalog })).toHaveAttribute("href", "/my-resellers/r-9/catalog");
    // Not theirs: no handoff to offer.
    expect(screen.queryByRole("button", { name: N.open })).toBeNull();
  });

  it("lets an owner holding a terminated reseller beside the live one pick which", async () => {
    owned = [ARIAN, { id: "r-0", slug: "old", here: false, hasPanel: false, live: false }];
    pathname = "/my-resellers/r-0/domains";
    render(<PanelSidebar />);
    const list = await screen.findByRole("list", { name: N.others });
    expect(within(list).getByRole("link", { name: "old" })).toHaveAttribute("aria-current", "true");
    expect(within(list).getByRole("link", { name: "arian" })).toHaveAttribute("href", "/reseller");
    expect(screen.getByRole("link", { name: N.menu.domains })).toHaveAttribute("href", "/my-resellers/r-0/domains");
  });

  it("is not drawn for a caller with no reseller", async () => {
    owned = [];
    render(<PanelSidebar />);
    await waitFor(() => expect(screen.getByRole("link", { name: S.menu.dashboard })).toBeInTheDocument());
    expect(screen.queryByRole("navigation", { name: N.switcher.label })).toBeNull();
  });
});

describe("the handoff, inside the reseller menu", () => {
  it("opens the owner's panel on its domain, from the platform", async () => {
    pathname = "/reseller";
    render(<PanelSidebar />);
    fireEvent.click(await screen.findByRole("button", { name: N.open }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://arianvpn.ir/auth/handoff#c0de"));
  });

  it("is disabled where it would be refused, and says why", async () => {
    owned = [{ ...ARIAN, hasPanel: false }];
    pathname = "/reseller";
    render(<PanelSidebar />);
    expect(await screen.findByRole("button", { name: N.open })).toBeDisabled();
    expect(screen.getByText(N.noPanel)).toBeInTheDocument();
  });

  it("is not offered on the reseller's own domain, where there is nowhere to hand off to", async () => {
    me = ON_DOMAIN;
    owned = [];
    pathname = "/reseller/bot";
    render(<PanelSidebar />);
    expect(await screen.findByRole("link", { name: N.menu.bot })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: N.open })).toBeNull();
  });
});
