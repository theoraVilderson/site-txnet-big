import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withResellerMenu } from "../_lib/reseller-menu";
import { afterPurchasePath } from "../resellers/_lib/purchase";
import { gateOpened, setupProgress } from "./_lib/setup";
import { useResellerSetup } from "../_hooks/useResellerSetup";

/**
 * Setup progress outside the wizard (UX-2-e, `contract.reseller-workspace.md`
 * "The setup wizard"): a menu row with the route's count until every step is
 * done, one celebration when the gate lifts while the panel is open — on the
 * live event, never a poll — and a bought reseller sent straight to the wizard.
 */

vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key }),
}));
vi.mock("../_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ me: { tenant: { id: "p-1", type: "platform_owner" }, permissions: [] }, group: { current: { userId: "u-1" } } }),
}));
vi.mock("@/lib/tenant-onboarding-api", () => ({ resellerOnboardingApi: { get: vi.fn() } }));
const { live, cheer, toast } = vi.hoisted(() => ({
  live: [] as { channel: string | null; types: readonly string[] | "any"; reread: () => void }[],
  cheer: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/hooks/useLiveReread", () => ({
  useLiveReread: (channel: string | null, types: readonly string[] | "any", reread: () => void) => {
    live.push({ channel, types, reread });
  },
}));
vi.mock("../_components/kit/celebrate", () => ({ celebrate: cheer }));
vi.mock("../_components/kit/notify", () => ({ notify: { success: toast } }));

import { resellerOnboardingApi, type ResellerOnboarding } from "@/lib/tenant-onboarding-api";

const view = (done: Partial<Record<"domain" | "gateway" | "bot" | "pricing", boolean>>): ResellerOnboarding => {
  const steps = (["domain", "gateway", "bot", "pricing"] as const).map((key) => ({ key, done: !!done[key], gate: key === "domain", optional: false, skipped: false }));
  return { tenantId: "r-1", onboarding: !done.domain, closed: [], steps, complete: steps.every((s) => s.done) };
};

beforeEach(() => {
  live.length = 0;
  cheer.mockReset();
  toast.mockReset();
  vi.mocked(resellerOnboardingApi.get).mockReset();
});

describe("the menu row", () => {
  it("carries the route's count and opens the wizard, until every step is done", () => {
    const ws = { id: "r-1", self: true };
    // The reseller button's pages, and the button itself.
    const button = (setup: Parameters<typeof withResellerMenu>[3]) =>
      withResellerMenu([], ws, "shop", setup).find((e) => e.id === "reseller") as { progress?: object; children: { id: string; href: string; progress?: object }[] };
    const open = button(setupProgress(view({ domain: true, gateway: true })));
    expect(open.children.find((l) => l.id === "reseller-setup")).toMatchObject({ href: "/reseller/setup", progress: { done: 2, total: 4 } });
    // Seen with the button closed, too.
    expect(open.progress).toEqual({ done: 2, total: 4 });

    const done = button(setupProgress(view({ domain: true, gateway: true, bot: true, pricing: true })));
    expect(done.children.some((l) => l.id === "reseller-setup")).toBe(false);
    expect(done.progress).toBeUndefined();
    // Not known yet: no row, never a guessed one.
    expect(button(null).children.some((l) => l.id === "reseller-setup")).toBe(false);
  });
});

describe("the gate lifting", () => {
  it("is a change seen live, never the first answer", () => {
    expect(gateOpened(setupProgress(view({})), setupProgress(view({ domain: true })))).toBe(true);
    expect(gateOpened(null, setupProgress(view({ domain: true })))).toBe(false);
    expect(gateOpened(setupProgress(view({ domain: true })), setupProgress(view({ domain: true, bot: true })))).toBe(false);
  });

  it("is celebrated once, on tenant.domain.changed", async () => {
    vi.mocked(resellerOnboardingApi.get).mockResolvedValueOnce(view({})).mockResolvedValue(view({ domain: true }));
    const { result } = renderHook(() => useResellerSetup("r-1"));
    await waitFor(() => expect(result.current.setup?.onboarding).toBe(true));
    expect(cheer).not.toHaveBeenCalled();

    const subscribed = live.filter((l) => Array.isArray(l.types) && l.types.includes("tenant.domain.changed") && l.channel === "user:u-1");
    expect(subscribed.length).toBeGreaterThan(0);
    await act(async () => subscribed.at(-1)!.reread());
    await waitFor(() => expect(result.current.setup?.onboarding).toBe(false));
    expect(cheer).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);

    await act(async () => result.current.reread());
    expect(cheer).toHaveBeenCalledTimes(1);
  });

  it("asks nothing with no reseller in play", () => {
    renderHook(() => useResellerSetup(null));
    expect(resellerOnboardingApi.get).not.toHaveBeenCalled();
  });
});

describe("after buying", () => {
  it("lands in the wizard, on the reseller's id-less address", () => {
    expect(afterPurchasePath("r-9")).toBe("/reseller/setup");
  });
});
