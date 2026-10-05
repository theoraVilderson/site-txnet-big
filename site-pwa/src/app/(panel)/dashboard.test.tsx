import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { DEFAULT_UI_PREFERENCES, useUiPreferences } from "@/stores/ui-preferences-store";
import { useDashboardStore } from "./_components/dashboard/useWidgetSource";
import { dashboardLayout, layoutToSave, timeOfDay, visibleWidgets, type WidgetDef } from "./_lib/widgets";
import Home from "./page";

/**
 * The dashboard's frame (UX-1-p, `contract.ux.md` D1–D3, D6):
 *
 * - the registry is gated like the menu — permissions, tenant type, and the
 *   page a widget links to;
 * - a saved layout is applied over the registry: an id the registry no longer
 *   has is ignored, a widget absent from the saved order takes its default
 *   place, and a hidden one is not drawn;
 * - "Edit layout" hides, moves up/down and resets, and Done writes `ui.dashboard`;
 * - a widget whose source fails says so with a retry; one answering 403 hides
 *   itself for the session;
 * - the header greets by the time of day in the caller's resolved zone.
 */

const D = FrontendI18nKeys.common.dashboard;

const source = vi.hoisted(() => ({ ask: vi.fn<() => Promise<string>>() }));

vi.mock("./_lib/widgets", async (importOriginal) => {
  const real = await importOriginal<typeof import("./_lib/widgets")>();
  const { createElement, lazy } = await import("react");
  const { useWidgetSource } = await import("./_components/dashboard/useWidgetSource");
  const { WidgetBody } = await import("./_components/dashboard/WidgetFrame");
  const Alpha = () => createElement("p", null, "alpha body");
  const Beta = () => {
    const s = useWidgetSource("beta", source.ask);
    return createElement(WidgetBody<string>, { source: s, children: (text: string) => createElement("p", null, text) });
  };
  const Gamma = () => createElement("p", null, "gamma body");
  const def = (id: string, C: () => unknown, extra: Record<string, unknown> = {}) => ({
    id,
    titleKey: `title.${id}`,
    size: 1 as const,
    component: lazy(async () => ({ default: C as () => null })),
    ...extra,
  });
  return {
    ...real,
    WIDGETS: [def("alpha", Alpha), def("beta", Beta), def("gamma", Gamma, { requires: ["tenant.manage"] })],
  };
});

let me: unknown = null;
const SESSION = {
  group: { current: { userId: "u-1", fullName: "Sara Ahmadi", phoneMasked: "0912***1234" }, members: [] },
  timeZone: { zone: "Asia/Tehran" },
  isLoading: false,
};
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${Object.values(vars).join("|")}` : key),
  }),
}));
vi.mock("./_context/PanelSessionContext", () => ({ usePanelSession: () => ({ ...SESSION, me }) }));
vi.mock("@/lib/tenant-api", () => ({
  resellerPurchaseApi: { mine: vi.fn(async () => ({ reseller: null })) },
  tenantAccessApi: { get: vi.fn(async () => ({ canRead: true })) },
}));
vi.mock("@/lib/auth-api", () => ({ authApi: { saveUiPreferences: vi.fn(async (p: unknown) => p) } }));

const USER = { userId: "u-1", permissions: [], tenant: { id: "t-1", type: "platform_owner", isOwner: false } };

const withLayout = (order: string[], hidden: string[] = []) =>
  useUiPreferences.setState({ prefs: { ...DEFAULT_UI_PREFERENCES, "ui.dashboard": { order, hidden } } });
const drawn = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));

beforeEach(() => {
  vi.clearAllMocks();
  me = USER;
  useUiPreferences.getState().reset();
  useDashboardStore.setState({ forbidden: {} });
  source.ask.mockResolvedValue("beta body");
});

describe("the registry and a saved layout (D1, D3, D6)", () => {
  const defs = [
    { id: "a", titleKey: "a", size: 1 },
    { id: "staff", titleKey: "s", size: 2, requires: ["payment.confirm_manual"] },
    { id: "platform", titleKey: "p", size: 1, tenantTypes: ["platform_owner"] },
    { id: "users", titleKey: "u", size: 1, page: "users" },
  ] as unknown as WidgetDef[];
  const gate = { held: [] as string[], tenantType: "reseller" as const, isOwner: false, menuIds: new Set<string>() };

  it("gates a widget like a menu entry, and by the page it links to", () => {
    expect(visibleWidgets(defs, gate).map((w) => w.id)).toEqual(["a"]);
    const staff = { ...gate, held: ["*"], tenantType: "platform_owner" as const, menuIds: new Set(["users"]) };
    expect(visibleWidgets(defs, staff).map((w) => w.id)).toEqual(["a", "staff", "platform", "users"]);
  });

  it("ignores an id the registry lost, and puts a new one in its default place", () => {
    expect(dashboardLayout(["a", "b", "c", "d"], { order: ["gone", "c", "a"], hidden: ["gone", "d"] })).toEqual({
      order: ["c", "d", "a", "b"],
      hidden: ["d"],
    });
    expect(dashboardLayout(["a", "b"], { order: [], hidden: [] })).toEqual({ order: ["a", "b"], hidden: [] });
  });

  it("keeps what the caller cannot see now when it saves, and drops what the registry lost", () => {
    const saved = { order: ["x", "gone", "a"], hidden: ["x"] };
    expect(layoutToSave(saved, ["a", "b", "x"], { order: ["b", "a"], hidden: ["a"] })).toEqual({
      order: ["b", "a", "x"],
      hidden: ["a", "x"],
    });
  });

  it("reads the hour in the caller's zone", () => {
    const at = new Date("2026-10-05T03:00:00Z"); // 06:30 in Tehran, 23:00 in New York
    expect(timeOfDay(at, "Asia/Tehran")).toBe("morning");
    expect(timeOfDay(at, "America/New_York")).toBe("night");
  });
});

describe("the dashboard (D1–D3)", () => {
  it("greets the caller and draws the widgets they may see, in the saved order", async () => {
    withLayout(["beta", "alpha"]);
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^dashboard\.greeting\.\w+\|Sara Ahmadi$/);
    expect(await screen.findByText("beta body")).toBeTruthy();
    expect(drawn()).toEqual(["title.beta", "title.alpha"]);
  });

  it("edits the layout and writes ui.dashboard on Done", async () => {
    render(<Home />);
    await screen.findByText("alpha body");
    fireEvent.click(screen.getByRole("button", { name: D.edit }));
    const editor = screen.getByRole("list", { name: D.edit });
    fireEvent.click(within(editor).getByRole("switch", { name: `${D.show}|title.alpha` }));
    fireEvent.click(within(editor).getByRole("button", { name: `${D.moveUp}|title.beta` }));
    fireEvent.click(screen.getByRole("button", { name: D.done }));
    expect(useUiPreferences.getState().prefs["ui.dashboard"]).toEqual({ order: ["beta", "alpha"], hidden: ["alpha"] });
    expect(await screen.findByText("beta body")).toBeTruthy();
    expect(screen.queryByText("alpha body")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: D.edit }));
    fireEvent.click(screen.getByRole("button", { name: D.reset }));
    fireEvent.click(screen.getByRole("button", { name: D.done }));
    expect(useUiPreferences.getState().prefs["ui.dashboard"]).toEqual({ order: [], hidden: [] });
  });

  it("says a failed source failed, and asks again on retry", async () => {
    source.ask.mockRejectedValueOnce(new Error("down"));
    render(<Home />);
    const retry = await screen.findByRole("button", { name: D.widget.retry });
    await act(async () => fireEvent.click(retry));
    expect(await screen.findByText("beta body")).toBeTruthy();
    expect(source.ask).toHaveBeenCalledTimes(2);
  });

  it("hides a widget whose source answers 403, for the session", async () => {
    source.ask.mockRejectedValue(new ApiError("forbidden", { status: 403 }));
    const { unmount } = render(<Home />);
    await waitFor(() => expect(drawn()).toEqual(["title.alpha"]));
    unmount();
    render(<Home />);
    await screen.findByText("alpha body");
    expect(drawn()).toEqual(["title.alpha"]);
    expect(source.ask).toHaveBeenCalledTimes(1);
  });
});
