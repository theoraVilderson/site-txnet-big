import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { myResellerConsolePath } from "@/lib/routes";
import { resellerPurchaseApi, type OwnedReseller } from "@/lib/tenant-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { ResellerSubscription } from "./_components/ResellerSubscription";
import { subscriptionState } from "./_lib/reseller-subscription";

/**
 * The caller's reseller subscription on My services (F-502-v,
 * `docs/interfaces/panel-web/contract.reseller-subscription.md`).
 *
 * > **Its own section above the Grants, never a Grant row.** A reseller bought
 * > with no VPN service left the page empty (user, 2026-10-08).
 *
 * > **The state is tenant's answer, read at the period end.** `suspended` is
 * > the tenant's status; a live one past `currentPeriodEnd` is in grace —
 * > the renewal is owed and not yet paid.
 *
 * > **A renewal re-reads it** (C-14, F-019-c1): paid, or told as a notice; never a clock.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/hooks/useLiveReread", () => ({ useLiveReread: vi.fn() }));
vi.mock("@/lib/tenant-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-api")>()),
  resellerPurchaseApi: { mine: vi.fn() },
}));

const K = FrontendI18nKeys.common.myServices.reseller;
const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;
const mine = vi.mocked(resellerPurchaseApi.mine);
const NOW = Date.parse("2026-10-08T12:00:00Z");

const HELD: OwnedReseller = {
  id: "t-1",
  slug: "sara-vpn",
  status: "active",
  billingModel: "subscription_monthly",
  package: { id: "p-1", name: "Silver" },
  currentPeriodEnd: "2026-11-01T00:00:00.000Z",
  domains: [],
};

function session(type: "platform_owner" | "reseller", isOwner = false) {
  vi.mocked(usePanelSession).mockReturnValue({
    me: { tenant: { id: "t-0", type, isOwner } },
    group: { current: { userId: "u-1" } },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  session("platform_owner");
});

describe("subscriptionState", () => {
  it("is the tenant's suspension, grace past the period end, active before it", () => {
    expect(subscriptionState({ ...HELD, status: "suspended" }, NOW)).toBe("suspended");
    expect(subscriptionState({ ...HELD, currentPeriodEnd: "2026-10-01T00:00:00.000Z" }, NOW)).toBe("grace");
    expect(subscriptionState({ ...HELD, status: "trial", currentPeriodEnd: "2026-10-01T00:00:00.000Z" }, NOW)).toBe("grace");
    expect(subscriptionState(HELD, NOW)).toBe("active");
    expect(subscriptionState({ ...HELD, package: null, currentPeriodEnd: null }, NOW)).toBe("active");
  });

  it("shows nothing for a terminated one, which `/purchase/mine` never answers", () => {
    expect(subscriptionState({ ...HELD, status: "terminated" }, NOW)).toBeNull();
  });
});

describe("ResellerSubscription", () => {
  it("shows the reseller, its package, period end, state and the way into its menu", async () => {
    mine.mockResolvedValue({ reseller: HELD });
    render(<ResellerSubscription />);

    const section = await screen.findByRole("region", { name: K.title });
    expect(section.closest("ul")).toBeNull();
    expect(section.textContent).toContain("sara-vpn");
    expect(section.textContent).toContain("Silver");
    expect(section.textContent).toContain(K.state.active);
    expect(screen.getByRole("link", { name: K.open }).getAttribute("href")).toBe(myResellerConsolePath("t-1", false));
  });

  it("says grace and what to do when the period ended unpaid", async () => {
    mine.mockResolvedValue({ reseller: { ...HELD, currentPeriodEnd: "2020-01-01T00:00:00.000Z" } });
    render(<ResellerSubscription />);
    expect(await screen.findByText(K.state.grace)).toBeTruthy();
    expect(screen.getByText(K.hint.grace)).toBeTruthy();
  });

  it("says suspended", async () => {
    mine.mockResolvedValue({ reseller: { ...HELD, status: "suspended" } });
    render(<ResellerSubscription />);
    expect(await screen.findByText(K.state.suspended)).toBeTruthy();
    expect(screen.getByText(K.hint.suspended)).toBeTruthy();
  });

  it("is nothing for a caller with no reseller, and a failed read costs this section only", async () => {
    mine.mockResolvedValueOnce({ reseller: null });
    const { container, unmount } = render(<ResellerSubscription />);
    await waitFor(() => expect(mine).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe("");
    unmount();

    mine.mockRejectedValueOnce(new Error("down"));
    const second = render(<ResellerSubscription />);
    await waitFor(() => expect(mine).toHaveBeenCalledTimes(2));
    expect(second.container.innerHTML).toBe("");
  });

  it("asks nothing of a reseller's own user or the platform owner, who cannot hold one", () => {
    session("reseller");
    render(<ResellerSubscription />);
    session("platform_owner", true);
    render(<ResellerSubscription />);
    expect(mine).not.toHaveBeenCalled();
  });

  it("re-reads on a paid renewal or a renewal's notice on the user's channel, with no clock", async () => {
    mine.mockResolvedValue({ reseller: HELD });
    render(<ResellerSubscription />);
    await screen.findByText(K.state.active);

    const [channel, types, reread] = vi.mocked(useLiveReread).mock.calls.at(-1)!;
    expect(channel).toBe("user:u-1");
    expect(types).toEqual([RealtimeEvents.tenantSubscriptionRenewed, RealtimeEvents.notificationCreated]);

    mine.mockResolvedValue({ reseller: { ...HELD, status: "suspended" } });
    act(() => reread("event"));
    expect(await screen.findByText(K.state.suspended)).toBeTruthy();
    expect(mine).toHaveBeenCalledTimes(2);
  });
});
