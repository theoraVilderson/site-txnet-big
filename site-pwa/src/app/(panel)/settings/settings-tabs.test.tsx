import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { authApi } from "@/lib/auth-api";
import { notificationApi } from "@/lib/notification-api";
import { DEFAULT_UI_PREFERENCES, useUiPreferences } from "@/stores/ui-preferences-store";
import { ConfirmProvider } from "../_components/kit/confirm";
import { notify } from "../_components/kit/notify";
import { settingsTabs } from "./_lib/settings";
import SettingsPage from "./page";

/**
 * Settings on tabs (UX-1-s, `contract.ux.md` S1–S2):
 *
 * - `profile`, `notifications`, `appearance`, and `workspace` only when one of
 *   its cards is allowed — "platform settings" on the platform, "reseller
 *   settings" on a reseller; `?tab=` holds the tab, `profile` by default;
 * - a tab once opened stays mounted, so an unsaved form survives a switch;
 * - a form saves through the `SaveBar` (K11); a pick that is one choice (the
 *   messenger, the motion level) is written at once, a failure put back.
 */

const T = FrontendI18nKeys.common.settings;
const KIT = FrontendI18nKeys.common.kit.saveBar;

let me: unknown = null;
let search = new URLSearchParams();
const listeners = new Set<() => void>();
const replace = vi.fn((url: string) => {
  search = new URLSearchParams(url.split("?")[1] ?? "");
  listeners.forEach((l) => l());
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () =>
    useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      () => search,
    ),
}));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "en",
    isRtl: false,
    availableLocales: [{ code: "en", name: "English" }, { code: "fa", name: "فارسی" }],
    setLang: vi.fn(),
    t: (_ns: string, key: string) => key,
  }),
}));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light", choice: "system", setTheme: vi.fn() }) }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me, zoneChanged: vi.fn(), reload: vi.fn() }) }));
vi.mock("../_components/kit/notify", () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("./_components/ProfileSection", () => ({ ProfileSection: () => <p>profile-section</p> }));
vi.mock("./_components/EmailSection", () => ({ EmailSection: () => <p>email-section</p> }));
vi.mock("./_components/SessionsSection", () => ({ SessionsSection: () => <p>sessions-section</p> }));
vi.mock("../_components/OperatingCurrencyCard", () => ({ OperatingCurrencyCard: () => <p>currency-card</p> }));
vi.mock("../_components/TenantTimeZoneCard", () => ({ TenantTimeZoneCard: () => <p>tenant-zone-card</p> }));
vi.mock("../_components/ManualRateCard", () => ({ ManualRateCard: () => <p>rate-card</p> }));
vi.mock("../_components/SelfMoveSettings", () => ({ SelfMoveSettings: ({ tenantId, productId }: { tenantId: string; productId: string | null }) => <p>self-move-card {tenantId} {String(productId)}</p> }));
vi.mock("@/lib/auth-api", () => ({
  authApi: {
    messenger: vi.fn(),
    saveMessenger: vi.fn(),
    timeZone: vi.fn(),
    saveTimeZone: vi.fn(),
    saveUiPreferences: vi.fn(),
  },
  NOTICE_MESSENGERS: ["both", "telegram", "bale"],
}));
vi.mock("@/lib/notification-api", () => ({
  NOTICE_KINDS: ["usage", "ending"],
  notificationApi: { preferences: vi.fn(), savePreferences: vi.fn() },
}));

const USER = { permissions: [], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };
const PLATFORM_STAFF = { permissions: ["settings.manage"], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };
const RESELLER_STAFF = { permissions: ["currency.pin"], tenant: { id: "t-2", type: "reseller", isOwner: false } };

const PREFS = { muted: [], quietHours: null, timezone: null };

const page = () =>
  render(
    <ConfirmProvider>
      <SettingsPage />
    </ConfirmProvider>,
  );
const tab = (name: string) => screen.getByRole("tab", { name });

beforeEach(() => {
  vi.clearAllMocks();
  me = USER;
  search = new URLSearchParams();
  useUiPreferences.getState().reset();
  vi.mocked(authApi.messenger).mockResolvedValue({ messenger: "both", linked: ["telegram"], chosen: false });
  vi.mocked(authApi.timeZone).mockResolvedValue({ timezone: null, source: null, resolved: { zone: "UTC", from: "default" } } as never);
  vi.mocked(notificationApi.preferences).mockResolvedValue(PREFS as never);
  vi.mocked(notificationApi.savePreferences).mockImplementation(async (p) => p);
});

describe("settingsTabs (S1)", () => {
  it("gives a plain user three tabs and no workspace", () => {
    expect(settingsTabs(USER as never).map((t) => t.value)).toEqual(["profile", "notifications", "appearance"]);
  });

  it("names the workspace for the platform and for a reseller", () => {
    expect(settingsTabs(PLATFORM_STAFF as never).at(-1)).toMatchObject({ value: "workspace", label: T.tabs.platform });
    expect(settingsTabs(RESELLER_STAFF as never).at(-1)).toMatchObject({ value: "workspace", label: T.tabs.reseller });
  });
});

describe("the settings page (S1–S2)", () => {
  it("opens on profile, and ?tab= picks another; a tab naming nothing reads as profile", async () => {
    page();
    expect(tab(T.tabs.profile)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("email-section")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: T.tabs.platform })).toBeNull();

    act(() => replace("/settings?tab=nothing"));
    expect(tab(T.tabs.profile)).toHaveAttribute("aria-selected", "true");

    fireEvent.click(tab(T.tabs.appearance));
    expect(replace).toHaveBeenLastCalledWith("/settings?tab=appearance", { scroll: false });
    expect(tab(T.tabs.appearance)).toHaveAttribute("aria-selected", "true");
  });

  it("draws the workspace's cards under its tab", () => {
    me = PLATFORM_STAFF;
    search = new URLSearchParams("tab=workspace");
    page();
    expect(tab(T.tabs.platform)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("currency-card")).toBeVisible();
    expect(screen.getByText("tenant-zone-card")).toBeVisible();
    // settings.manage alone: the self-move card is catalog.manage's (F-410-h).
    expect(screen.queryByText(/self-move-card/)).toBeNull();
  });

  it("draws the platform's own self-move card for its staff holding catalog.manage (F-410-h)", () => {
    me = { ...PLATFORM_STAFF, permissions: ["catalog.manage"] };
    search = new URLSearchParams("tab=workspace");
    page();
    expect(screen.getByText("self-move-card t-1 null")).toBeVisible();
    expect(screen.queryByText("currency-card")).toBeNull();
  });

  it("writes the motion level from appearance at once", async () => {
    search = new URLSearchParams("tab=appearance");
    page();
    fireEvent.click(await screen.findByRole("radio", { name: T.appearance.motion.reduced }));
    expect(useUiPreferences.getState().prefs["ui.motion"]).toBe("reduced");
  });

  it("saves notices through the SaveBar, and keeps an unsaved change across a tab switch", async () => {
    search = new URLSearchParams("tab=notifications");
    page();
    const [usage] = await screen.findAllByRole("switch");
    fireEvent.click(usage);
    const bar = await screen.findByRole("region", { name: KIT.unsaved });

    fireEvent.click(tab(T.tabs.profile));
    fireEvent.click(tab(T.tabs.notifications));
    expect(screen.getAllByRole("switch")[0]).not.toBeChecked();

    fireEvent.click(within(bar).getByRole("button", { name: KIT.save }));
    await waitFor(() => expect(notificationApi.savePreferences).toHaveBeenCalledWith({ ...PREFS, muted: ["usage"] }));
    await waitFor(() => expect(screen.queryByRole("region", { name: KIT.unsaved })).toBeNull());
  });

  it("discards an unsaved notice change back to what was stored", async () => {
    search = new URLSearchParams("tab=notifications");
    page();
    const [usage] = await screen.findAllByRole("switch");
    fireEvent.click(usage);
    fireEvent.click(within(await screen.findByRole("region", { name: KIT.unsaved })).getByRole("button", { name: KIT.discard }));
    expect(screen.getAllByRole("switch")[0]).toBeChecked();
    expect(notificationApi.savePreferences).not.toHaveBeenCalled();
  });

  it("saves a messenger pick at once, and puts it back when refused", async () => {
    search = new URLSearchParams("tab=notifications");
    vi.mocked(authApi.saveMessenger).mockRejectedValueOnce(new Error("down"));
    page();
    const telegram = await screen.findByRole("radio", { name: new RegExp(T.messenger.options.telegram) });
    fireEvent.click(telegram);
    expect(authApi.saveMessenger).toHaveBeenCalledWith("telegram");
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    expect(screen.getByRole("radio", { name: new RegExp(T.messenger.options.both) })).toBeChecked();

    vi.mocked(authApi.saveMessenger).mockResolvedValueOnce({ messenger: "bale", linked: ["telegram"], chosen: true });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(T.messenger.options.bale) }));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith(T.messenger.saved));
    expect(screen.getByRole("radio", { name: new RegExp(T.messenger.options.bale) })).toBeChecked();
  });

  it("is never one 560px column again: one tab list, from lg a side nav", () => {
    page();
    const [list] = screen.getAllByRole("tablist");
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(list.className).toContain("lg:flex-col");
  });
});

void DEFAULT_UI_PREFERENCES;
