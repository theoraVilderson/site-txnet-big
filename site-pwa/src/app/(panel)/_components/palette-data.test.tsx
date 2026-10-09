import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { authApi, resellerUsersApi } from "@/lib/auth-api";
import { billingApi } from "@/lib/billing-api";
import { panelSupportThreadPath, panelUserPath } from "@/lib/routes";
import { supportApi } from "@/lib/support-api";
import { tenantAccessApi } from "@/lib/tenant-api";
import { useUiPreferences } from "@/stores/ui-preferences-store";
import { resetPaletteDataForTests } from "../_hooks/usePaletteData";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { CommandPalette } from "./CommandPalette";

/**
 * Data in the palette (UX-1-o, `contract.ux.md` N7):
 *
 * - each group asks its own source 300ms after typing rests, from 2 characters
 *   (the user searches from 3: both routes refuse fewer);
 * - services by name, or by a pasted config link — which goes in a POST body,
 *   never into a link the palette opens;
 * - the caller's tickets by `q` (UX-1-v);
 * - users only for a caller whose menu shows the users page: the platform's
 *   `GET /auth/users`, a reseller's own `GET /auth/tenants/:id/users`;
 * - a group whose source answers 403 hides itself for the session; any other
 *   failure leaves the other groups alone.
 */

const P = FrontendI18nKeys.common.shell.palette;

let me: unknown = null;
const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "en",
    isRtl: false,
    availableLocales: [{ code: "en", name: "English" }],
    setLang: vi.fn(),
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${Object.values(vars).join("|")}` : key),
    tIn: (_lang: string, _ns: string, key: string) => key,
  }),
}));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light", choice: "system", setTheme: vi.fn() }) }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me }) }));
vi.mock("@/lib/tenant-api", () => ({
  resellerPurchaseApi: { mine: vi.fn(async () => ({ reseller: null })) },
  tenantAccessApi: { get: vi.fn(async () => ({ canRead: true })) },
}));
vi.mock("@/lib/auth-api", () => ({
  authApi: { saveUiPreferences: vi.fn(async (p: unknown) => p), searchUsers: vi.fn() },
  resellerUsersApi: { list: vi.fn() },
}));
vi.mock("@/lib/billing-api", () => ({ billingApi: { grants: vi.fn(), grantsByLines: vi.fn() } }));
vi.mock("@/lib/support-api", () => ({ supportApi: { search: vi.fn() } }));

const USER = { userId: "u-1", permissions: [], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };
const PLATFORM_STAFF = { userId: "u-2", permissions: ["*"], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };
const RESELLER_STAFF = { userId: "u-3", permissions: ["tenant.manage"], tenant: { id: "t-9", type: "reseller", isOwner: false } };

const GRANT = { id: "g-1", label: "Home VPN", variant: { id: "v-1", sku: "VPN-30", nameKey: "vpn" } };
const TICKET = { id: "c-1", subject: "Slow connection", status: "open" };
const HIT = { id: "user-7", fullName: "Sara Ahmadi", username: "sara", phoneMasked: "0912***1234", status: "active" };
const forbidden = () => new ApiError("forbidden", { status: 403 });

const open = async () => {
  render(<CommandPalette />);
  await act(async () => {
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
  });
  return screen.getByRole("combobox", { name: P.label });
};
const type = (value: string) => fireEvent.change(screen.getByRole("combobox", { name: P.label }), { target: { value } });
const group = (name: string) => screen.queryByRole("group", { name });

beforeEach(() => {
  vi.clearAllMocks();
  resetPaletteDataForTests();
  me = USER;
  usePanelUiStore.setState({ paletteOpen: false });
  useUiPreferences.getState().reset();
  vi.mocked(billingApi.grants).mockResolvedValue({ rows: [GRANT], total: 1, page: 1, pageSize: 8, hidden: 0 } as never);
  vi.mocked(billingApi.grantsByLines).mockResolvedValue({ rows: [GRANT], total: 1, page: 1, pageSize: 8, hidden: 0 } as never);
  vi.mocked(supportApi.search).mockResolvedValue({ items: [TICKET], nextBefore: null } as never);
  vi.mocked(authApi.searchUsers).mockResolvedValue({ users: [HIT] } as never);
  vi.mocked(resellerUsersApi.list).mockResolvedValue({ items: [HIT], total: 1, page: 1, pageSize: 8 } as never);
  vi.mocked(tenantAccessApi.get).mockResolvedValue({ canRead: true } as never);
});

describe("palette data groups (N7)", () => {
  it("asks nothing for one character, and nothing before typing has rested 300ms", async () => {
    await open();
    type("v");
    await new Promise((r) => setTimeout(r, 350));
    expect(billingApi.grants).not.toHaveBeenCalled();

    type("vp");
    expect(billingApi.grants).not.toHaveBeenCalled();
    await waitFor(() => expect(billingApi.grants).toHaveBeenCalledWith(1, 8, "all", "vp"));
    expect(supportApi.search).toHaveBeenCalledWith("vp", 8);
  });

  it("finds services by name and opens My services on the same search", async () => {
    await open();
    type("home");
    const services = await screen.findByRole("group", { name: P.groups.services });
    fireEvent.click(screen.getByRole("option", { name: /Home VPN/ }));
    expect(push).toHaveBeenCalledWith("/services?q=home");
    expect(services).toBeDefined();
  });

  it("sends a pasted config link in a body, and never puts it in the link it opens", async () => {
    await open();
    type("vless://secret@host:443#cfg");
    await screen.findByRole("group", { name: P.groups.services });
    expect(billingApi.grantsByLines).toHaveBeenCalledWith(["vless://secret@host:443#cfg"], 1, 8, "all");
    expect(billingApi.grants).not.toHaveBeenCalled();
    expect(supportApi.search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /Home VPN/ }));
    expect(push).toHaveBeenCalledWith("/services?q=Home%20VPN");
    expect(push.mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it("finds the caller's tickets and opens the thread", async () => {
    await open();
    type("slow");
    await screen.findByRole("group", { name: P.groups.tickets });
    fireEvent.click(screen.getByRole("option", { name: /Slow connection/ }));
    expect(push).toHaveBeenCalledWith(panelSupportThreadPath("c-1"));
  });

  it("offers users only where the users page is visible, from 3 characters, by the platform's route", async () => {
    await open();
    type("sara");
    await screen.findByRole("group", { name: P.groups.services });
    expect(authApi.searchUsers).not.toHaveBeenCalled();
    expect(group(P.groups.users)).toBeNull();
  });

  it("asks the platform's search for platform staff, and links the user's page", async () => {
    me = PLATFORM_STAFF;
    await open();
    type("sa");
    await screen.findByRole("group", { name: P.groups.services });
    expect(authApi.searchUsers).not.toHaveBeenCalled();
    type("sara");
    await screen.findByRole("group", { name: P.groups.users });
    expect(authApi.searchUsers).toHaveBeenCalledWith("sara");
    fireEvent.click(screen.getByRole("option", { name: /Sara Ahmadi/ }));
    expect(push).toHaveBeenCalledWith(panelUserPath("user-7"));
  });

  // `tenant.manage` is retired (AC-1-d); AC-1-e2 gives a seat its pages by its own keys and turns this back on.
  it.skip("AC-1-e2: asks a reseller's own users route for its staff", async () => {
    me = RESELLER_STAFF;
    await open();
    type("sara");
    await screen.findByRole("group", { name: P.groups.users });
    expect(resellerUsersApi.list).toHaveBeenCalledWith("t-9", { q: "sara", page: 1, pageSize: 8 });
    expect(authApi.searchUsers).not.toHaveBeenCalled();
  });

  it("hides a group whose source answers 403 for the rest of the session; another failure leaves the rest", async () => {
    me = PLATFORM_STAFF;
    vi.mocked(authApi.searchUsers).mockRejectedValue(forbidden());
    vi.mocked(supportApi.search).mockRejectedValue(new ApiError("down", { status: 500 }));
    await open();
    type("sara");
    await screen.findByRole("group", { name: P.groups.services });
    await waitFor(() => expect(authApi.searchUsers).toHaveBeenCalledTimes(1));
    expect(group(P.groups.users)).toBeNull();
    expect(group(P.groups.tickets)).toBeNull();

    type("sarah");
    await waitFor(() => expect(supportApi.search).toHaveBeenCalledWith("sarah", 8));
    expect(authApi.searchUsers).toHaveBeenCalledTimes(1);
  });
});
