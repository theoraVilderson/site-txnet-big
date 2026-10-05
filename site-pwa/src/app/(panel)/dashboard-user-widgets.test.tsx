import { fireEvent, render, screen, within } from "@testing-library/react";
import { Suspense, type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { wheelApi } from "@/lib/engagement-api";
import { notificationApi } from "@/lib/notification-api";
import { PANEL_DEPOSIT, PANEL_SHOP, PANEL_SUPPORT_NEW, panelSupportThreadPath } from "@/lib/routes";
import { supportApi } from "@/lib/support-api";
import { usePanelUiStore } from "./_stores/panel-ui-store";
import { runningOut } from "./services/_lib/pulse";
import { WIDGETS } from "./_lib/widgets";

/**
 * The user's widgets (UX-1-q, `contract.ux.md` D4, U3), each over an API that
 * already exists:
 *
 * - quick actions: top up, gift code, buy, new ticket;
 * - wallet: the balance, what is held apart, top up and gift code;
 * - services: the active ones, "running out" — ending within 3 days or 10% or
 *   less of the quota left — as a gold pill, in the list's own order;
 * - support: open threads, unread first; notifications: the latest 5;
 * - wheel: whether a spin is open today.
 */

const D = FrontendI18nKeys.common.dashboard;

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${Object.values(vars).join("|")}` : key),
  }),
}));
vi.mock("./_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ me: null, group: { current: { userId: "u-1" }, members: [] }, timeZone: null }),
}));
vi.mock("./_context/PanelRealtimeContext", () => ({ usePanelRealtime: () => null }));
vi.mock("@/lib/billing-api", () => ({ billingApi: { walletBalance: vi.fn(), grants: vi.fn() } }));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { texts: vi.fn(async () => ({})) } }));
vi.mock("@/lib/support-api", () => ({ supportApi: { list: vi.fn() } }));
vi.mock("@/lib/notification-api", () => ({ notificationApi: { inbox: vi.fn() } }));
vi.mock("@/lib/engagement-api", () => ({ wheelApi: { view: vi.fn() } }));

const NOW = new Date("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const grant = (id: string, over: Partial<GrantRow> = {}): GrantRow => ({
  id,
  label: `service ${id}`,
  status: "active",
  startsAt: at(-10 * DAY),
  endsAt: at(20 * DAY),
  featureKeys: [],
  variant: null,
  billingMode: "prepaid",
  consumedBytes: "100",
  purchasedBytes: "0",
  trafficUnlimited: false,
  trafficCapBytes: "1000",
  suspendedAt: null,
  purgeAt: null,
  lastTrafficAt: null,
  ...over,
});

const widget = (id: string) => {
  const def = WIDGETS.find((w) => w.id === id);
  if (!def) throw new Error(`no widget ${id}`);
  const Body = def.component as unknown as ComponentType;
  return render(
    <Suspense fallback={null}>
      <Body />
    </Suspense>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  usePanelUiStore.setState({ giftCodeOpen: false });
});

describe("the registry (D4, D6)", () => {
  it("holds the user's widgets in D6's order, accounts last, none of them gated", () => {
    const USER = ["quick-actions", "wallet", "services", "support", "notifications", "wheel", "accounts"];
    const ids = WIDGETS.map((w) => w.id);
    expect(ids.filter((id) => USER.includes(id))).toEqual(USER);
    expect(ids.slice(-4)).toEqual(USER.slice(-4));
    expect(WIDGETS.filter((w) => USER.includes(w.id)).every((w) => !w.requires && !w.tenantTypes && !w.page)).toBe(true);
    expect(WIDGETS.find((w) => w.id === "services")?.size).toBe(2);
  });
});

describe("running out (U3)", () => {
  it("is 3 days or less to the end, or 10% or less of a bounded quota left", () => {
    expect(runningOut(grant("a"), NOW)).toBe(false);
    expect(runningOut(grant("b", { endsAt: at(3 * DAY) }), NOW)).toBe(true);
    expect(runningOut(grant("c", { consumedBytes: "900" }), NOW)).toBe(true);
    expect(runningOut(grant("d", { consumedBytes: "899" }), NOW)).toBe(false);
    // Unlimited and metered traffic have no quota to run out of; an ended one is not "running out".
    expect(runningOut(grant("e", { trafficUnlimited: true, trafficCapBytes: null, consumedBytes: "999999" }), NOW)).toBe(false);
    expect(runningOut(grant("f", { billingMode: "metered", trafficCapBytes: null, purchasedBytes: "1000", consumedBytes: "990" }), NOW)).toBe(false);
    expect(runningOut(grant("g", { endsAt: at(-DAY) }), NOW)).toBe(false);
  });
});

describe("the widgets (D4)", () => {
  it("quick actions: top up, gift code, buy and a new ticket", async () => {
    widget("quick-actions");
    expect((await screen.findByRole("link", { name: D.quick.topUp })).getAttribute("href")).toBe(PANEL_DEPOSIT);
    expect(screen.getByRole("link", { name: D.quick.buy }).getAttribute("href")).toBe(PANEL_SHOP);
    expect(screen.getByRole("link", { name: D.quick.newTicket }).getAttribute("href")).toBe(PANEL_SUPPORT_NEW);
    fireEvent.click(screen.getByRole("button", { name: D.quick.giftCode }));
    expect(usePanelUiStore.getState().giftCodeOpen).toBe(true);
  });

  it("wallet: the balance, and what is held apart", async () => {
    vi.mocked(billingApi.walletBalance).mockResolvedValue({ balance: "150000.00", held: "50000.00", available: "100000.00", currencyCode: "IRR" } as never);
    widget("wallet");
    expect(await screen.findByText(new RegExp(`^${D.wallet.held.replace(/\./g, "\\.")}\\|`))).toBeTruthy();
    expect(screen.getByRole("link", { name: D.quick.topUp }).getAttribute("href")).toBe(PANEL_DEPOSIT);
    expect(screen.getByRole("button", { name: D.quick.giftCode })).toBeTruthy();
  });

  it("services: the active ones, running out marked gold, in the list's order", async () => {
    vi.mocked(billingApi.grants).mockResolvedValue({
      rows: [grant("a"), grant("b", { endsAt: at(DAY) }), grant("p", { status: "pending" }), grant("c", { consumedBytes: "950" })],
      total: 4,
      hidden: 0,
    } as never);
    widget("services");
    const items = await screen.findAllByRole("listitem");
    expect(items.map((li) => within(li).getByRole("link").textContent)).toEqual(["service a", "service b", "service c"]);
    const pills = screen.getAllByText(D.services.runningOut);
    expect(pills).toHaveLength(2);
    expect(pills.every((p) => p.closest("[data-tone]")?.getAttribute("data-tone") === "gold")).toBe(true);
    expect(within(items[0]).queryByText(D.services.runningOut)).toBeNull();
  });

  it("services: none active offers to buy one", async () => {
    vi.mocked(billingApi.grants).mockResolvedValue({ rows: [], total: 0, hidden: 0 } as never);
    widget("services");
    expect((await screen.findByRole("link", { name: D.quick.buy })).getAttribute("href")).toBe(PANEL_SHOP);
    expect(screen.getByText(D.services.empty)).toBeTruthy();
  });

  it("support: open threads only, unread first", async () => {
    vi.mocked(supportApi.list).mockResolvedValue({
      items: [
        { id: "t1", subject: "Old question", status: "pending_user", unread: 0, lastMessageAt: at(-DAY) },
        { id: "t2", subject: "Settled", status: "resolved", unread: 3, lastMessageAt: at(-DAY) },
        { id: "t3", subject: "Slow connection", status: "open", unread: 2, lastMessageAt: at(-2 * DAY) },
      ],
      nextBefore: null,
    } as never);
    widget("support");
    const links = await screen.findAllByRole("link", { name: /Old question|Slow connection|Settled/ });
    expect(links.map((a) => a.getAttribute("href"))).toEqual([panelSupportThreadPath("t3"), panelSupportThreadPath("t1")]);
  });

  it("notifications: the latest 5", async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, type: "x", title: `note ${i}`, body: "", readAt: null, createdAt: at(-i * 1000) }));
    vi.mocked(notificationApi.inbox).mockResolvedValue({ items, unreadCount: 7, page: 1, pageSize: 10, total: 7 } as never);
    widget("notifications");
    await screen.findByText("note 0");
    expect(screen.getAllByText(/^note \d$/).map((n) => n.textContent)).toEqual(["note 0", "note 1", "note 2", "note 3", "note 4"]);
  });

  it("wheel: says whether a spin is open today", async () => {
    vi.mocked(wheelApi.view).mockResolvedValue({ eligible: true, spinsLeftToday: 1, nextSpinAt: null, refusalReason: null } as never);
    const { unmount } = widget("wheel");
    expect(await screen.findByText(D.wheel.open)).toBeTruthy();
    unmount();
    vi.mocked(wheelApi.view).mockResolvedValue({ eligible: false, spinsLeftToday: 0, nextSpinAt: null, refusalReason: "daily_limit" } as never);
    widget("wheel");
    expect(await screen.findByText(D.wheel.closed)).toBeTruthy();
  });
});
