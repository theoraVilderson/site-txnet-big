import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_DEPOSIT, PANEL_SUPPORT_NEW, PANEL_WHEEL, panelSettingsTabPath } from "@/lib/routes";
import { useUiPreferences } from "@/stores/ui-preferences-store";
import { foldForSearch, matchScore } from "../_lib/palette";
import { recordRecentPage } from "../_lib/recent-pages";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { CommandPalette, PaletteButton } from "./CommandPalette";

/**
 * The command palette (UX-1-n, `contract.ux.md` N6):
 *
 * - Ctrl/⌘+K (by the key's place, so a Persian layout works too) and the top
 *   bar's button open it; Esc closes it;
 * - it finds pages of the caller's visible menu only, settings tabs, actions
 *   and — before anything is typed — recent pages;
 * - matching ignores case, folds Arabic ي/ك into ی/ک and Persian/Arabic digits
 *   into Latin, and reads every label in the current language and English;
 * - arrows move, Enter runs, Shift+Enter pins or unpins a page.
 */

const P = FrontendI18nKeys.common.shell.palette;
const M = FrontendI18nKeys.common.shell.menu;
const A = FrontendI18nKeys.common.settings.appearance;

let me: unknown = null;
const push = vi.fn();
const setTheme = vi.fn();
const setLang = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push, replace: vi.fn() }) }));
// The current language is Persian; `tIn("en", …)` is the English label.
const fa: Record<string, string> = { [M.wallet]: "کیف پول", [M.deposit]: "شارژ", [M.wheel]: "گردونه", [M.support]: "پشتیبانی" };
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "fa",
    isRtl: true,
    availableLocales: [{ code: "fa", name: "فارسی" }, { code: "en", name: "English" }],
    setLang,
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => {
      const base = fa[key] ?? key;
      return vars ? `${base}|${Object.values(vars).join("|")}` : base;
    },
    tIn: (lang: string, _ns: string, key: string) => (lang === "en" ? `en:${key}` : key),
  }),
}));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light", choice: "system", setTheme }) }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me }) }));
vi.mock("@/lib/tenant-api", () => ({
  resellerPurchaseApi: { mine: vi.fn(async () => ({ reseller: null })) },
  tenantAccessApi: { get: vi.fn(async () => ({ canRead: false })) },
}));
vi.mock("@/lib/auth-api", () => ({ authApi: { saveUiPreferences: vi.fn(async (p: unknown) => p) } }));

const USER = { permissions: [], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };

const open = async () => {
  render(<CommandPalette />);
  await act(async () => {
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
  });
  return screen.getByRole("combobox", { name: P.label });
};
const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });
const options = () => screen.queryAllByRole("option").map((o) => o.getAttribute("data-label"));

beforeEach(() => {
  vi.clearAllMocks();
  me = USER;
  localStorage.clear();
  usePanelUiStore.setState({ paletteOpen: false, giftCodeOpen: false });
  useUiPreferences.getState().reset();
});

describe("foldForSearch and matchScore (N6)", () => {
  it("lowers case, folds Arabic ي/ك into Persian and every digit into Latin", () => {
    expect(foldForSearch("كيف")).toBe("کیف");
    expect(foldForSearch("Wallet ۱۲۳ ١٢٣")).toBe("wallet 123 123");
  });

  it("matches every word of the query, a label's start above its middle", () => {
    expect(matchScore("wal", ["Wallet"])).toBeGreaterThan(matchScore("let", ["Wallet"]));
    expect(matchScore("top wal", ["Top up the wallet"])).toBeGreaterThan(0);
    expect(matchScore("top xyz", ["Top up the wallet"])).toBe(0);
  });
});

describe("CommandPalette", () => {
  it("opens on Ctrl+K by the key's place, on ⌘+K, and from the top bar's button; Esc closes it", async () => {
    const box = await open();
    expect(box).toHaveFocus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(usePanelUiStore.getState().paletteOpen).toBe(false);

    // A Persian layout sends "ن" for the K key.
    act(() => void fireEvent.keyDown(window, { key: "ن", code: "KeyK", metaKey: true }));
    expect(usePanelUiStore.getState().paletteOpen).toBe(true);
    act(() => usePanelUiStore.setState({ paletteOpen: false }));

    render(<PaletteButton />);
    fireEvent.click(screen.getByRole("button", { name: P.openHint }));
    expect(usePanelUiStore.getState().paletteOpen).toBe(true);
  });

  it("finds a page by its English label in a Persian panel, and Enter opens it", async () => {
    const box = await open();
    type(box, "wheel");
    expect(options()[0]).toBe("گردونه");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(push).toHaveBeenCalledWith(PANEL_WHEEL);
    expect(usePanelUiStore.getState().paletteOpen).toBe(false);
  });

  it("never offers a page the caller may not open", async () => {
    const box = await open();
    type(box, "catalog");
    expect(options()).not.toContain(M.catalog);
  });

  it("folds what is typed: Arabic letters find the Persian label", async () => {
    const box = await open();
    type(box, "كيف");
    // A page inside a group is found by its group's name too.
    expect(options()).toContain("شارژ");
  });

  it("moves with the arrows and runs the highlighted one", async () => {
    const box = await open();
    type(box, "menu");
    const first = options()[0];
    fireEvent.keyDown(box, { key: "ArrowDown" });
    const active = screen.getAllByRole("option").find((o) => o.id === box.getAttribute("aria-activedescendant"));
    expect(active?.getAttribute("data-label")).toBe(options()[1]);
    expect(active?.getAttribute("data-label")).not.toBe(first);
  });

  it("finds settings tabs and opens them by ?tab=", async () => {
    const box = await open();
    type(box, "notifications");
    const tab = screen.getAllByRole("option").find((o) => o.getAttribute("data-href") === panelSettingsTabPath("notifications"));
    expect(tab).toBeDefined();
    fireEvent.click(tab!);
    expect(push).toHaveBeenCalledWith(panelSettingsTabPath("notifications"));
  });

  it("runs actions: top up, a new ticket, the gift code, theme, language and motion", async () => {
    await open();
    // Each run closes the palette; reopened, its box is a new element.
    const run = (query: string, label: string) => {
      type(screen.getByRole("combobox", { name: P.label }), query);
      fireEvent.click(screen.getAllByRole("option").find((o) => o.getAttribute("data-label") === label)!);
      act(() => usePanelUiStore.setState({ paletteOpen: true }));
    };
    run("top up", P.actions.topUp);
    expect(push).toHaveBeenCalledWith(PANEL_DEPOSIT);
    run("ticket", P.actions.newTicket);
    expect(push).toHaveBeenCalledWith(PANEL_SUPPORT_NEW);
    run("gift", P.actions.giftCode);
    expect(usePanelUiStore.getState().giftCodeOpen).toBe(true);
    run("dark", `${P.actions.theme}|${A.themes.dark}`);
    expect(setTheme).toHaveBeenCalledWith("dark");
    run("english", `${P.actions.language}|English`);
    expect(setLang).toHaveBeenCalledWith("en");
    run("reduced", `${P.actions.motion}|${A.motion.reduced}`);
    expect(useUiPreferences.getState().prefs["ui.motion"]).toBe("reduced");
  });

  it("shows recent pages before anything is typed, only those still visible", async () => {
    recordRecentPage({ href: "/catalog", id: "catalog" });
    recordRecentPage({ href: PANEL_WHEEL, id: "wheel" });
    await open();
    const recent = screen.getByRole("group", { name: P.groups.recent });
    expect(within(recent).getAllByRole("option").map((o) => o.getAttribute("data-label"))).toEqual(["گردونه"]);
  });

  it("pins and unpins the highlighted page with Shift+Enter", async () => {
    const box = await open();
    type(box, "support");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(useUiPreferences.getState().prefs["ui.pins"]).toEqual(["support"]);
    expect(usePanelUiStore.getState().paletteOpen).toBe(true);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(useUiPreferences.getState().prefs["ui.pins"]).toEqual([]);
  });

  it("says when nothing matches", async () => {
    const box = await open();
    type(box, "zzzz");
    expect(screen.getByText(`${P.empty}|zzzz`)).toBeInTheDocument();
  });
});
