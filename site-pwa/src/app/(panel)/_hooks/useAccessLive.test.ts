import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAccessLive, useAccessLost } from "./useAccessLive";
import { usePanelRealtime } from "@/app/(panel)/_context/PanelRealtimeContext";
import { usePanelSession } from "@/app/(panel)/_context/PanelSessionContext";
import { authApi, type Me } from "@/lib/auth-api";
import { RealtimeEvents } from "@/generated/wire";

/**
 * AC-1-r: a person's access moved (`identity.access.changed`, AC-1-q) — the
 * panel refreshes its token once, `me` follows it (F-101-c's listener), and an
 * open page whose menu entry went with it says so instead of failing later.
 */

vi.mock("@/app/(panel)/_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));
vi.mock("@/app/(panel)/_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/lib/auth-api", () => ({ authApi: { refreshAccess: vi.fn() } }));

const realtime = vi.mocked(usePanelRealtime);
const session = vi.mocked(usePanelSession);
const refreshAccess = vi.mocked(authApi.refreshAccess);

function fakeClient() {
  const fake = {
    channels: [] as string[],
    onMessage: null as ((payload: unknown) => void) | null,
    onMissed: null as (() => void) | null,
    subscribe: vi.fn((channel: string, options: { onMessage: (p: unknown) => void; onMissed?: () => void }) => {
      fake.channels.push(channel);
      fake.onMessage = options.onMessage;
      fake.onMissed = options.onMissed ?? null;
      return () => {};
    }),
  };
  return fake;
}
let client: ReturnType<typeof fakeClient>;

beforeEach(() => {
  vi.useFakeTimers();
  client = fakeClient();
  realtime.mockReturnValue(client as never);
  session.mockReturnValue({ group: { current: { userId: "u-1" } } } as never);
  refreshAccess.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAccessLive", () => {
  it("refreshes the token once on access.changed, on the person's own channel", () => {
    renderHook(() => useAccessLive());
    expect(client.channels).toEqual(["user:u-1"]);

    client.onMessage!({ type: RealtimeEvents.paymentConfirmed });
    expect(refreshAccess).not.toHaveBeenCalled();

    client.onMessage!({ type: RealtimeEvents.accessChanged });
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });

  it("refreshes after a reconnect too: a change sent while the socket was down reached nobody", () => {
    renderHook(() => useAccessLive());
    client.onMissed!();
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });

  it("subscribes to nothing before the session names a person", () => {
    session.mockReturnValue({ group: null } as never);
    renderHook(() => useAccessLive());
    expect(client.channels).toEqual([]);
  });

  it("a refresh that fails is not thrown at the page", async () => {
    refreshAccess.mockRejectedValue(new Error("cookie gone"));
    renderHook(() => useAccessLive());
    client.onMessage!({ type: RealtimeEvents.accessChanged });
    await vi.runAllTimersAsync();
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });
});

const me = (permissions: string[]) => ({ permissions }) as unknown as Me;
const HREFS = ["/dashboard", "/wheel/settings", "/support"];

describe("useAccessLost", () => {
  type P = { me: Me | null; hrefs: string[]; path: string };
  const render = (initial: P) =>
    renderHook((p: P) => useAccessLost(p.me, p.hrefs, p.path), { initialProps: initial });

  it("the open page's entry leaves the menu when `me` moves: lost", () => {
    const hook = render({ me: me(["engagement.manage"]), hrefs: HREFS, path: "/wheel/settings" });
    expect(hook.result.current).toBe(false);
    hook.rerender({ me: me([]), hrefs: ["/dashboard", "/support"], path: "/wheel/settings" });
    expect(hook.result.current).toBe(true);
  });

  it("the entry comes back: no longer lost", () => {
    const hook = render({ me: me(["engagement.manage"]), hrefs: HREFS, path: "/wheel/settings" });
    hook.rerender({ me: me([]), hrefs: ["/dashboard", "/support"], path: "/wheel/settings" });
    hook.rerender({ me: me(["engagement.manage"]), hrefs: HREFS, path: "/wheel/settings" });
    expect(hook.result.current).toBe(false);
  });

  it("navigating away clears it", () => {
    const hook = render({ me: me(["engagement.manage"]), hrefs: HREFS, path: "/wheel/settings" });
    hook.rerender({ me: me([]), hrefs: ["/dashboard", "/support"], path: "/wheel/settings" });
    hook.rerender({ me: me([]), hrefs: ["/dashboard", "/support"], path: "/support" });
    expect(hook.result.current).toBe(false);
  });

  it("the first `me` of a page load is not a loss, whatever the menu did before it", () => {
    const hook = render({ me: null, hrefs: ["/dashboard"], path: "/wheel/settings" });
    hook.rerender({ me: me([]), hrefs: ["/dashboard", "/support"], path: "/wheel/settings" });
    expect(hook.result.current).toBe(false);
  });

  it("a menu that moves without `me` moving (an async entry) is not a loss", () => {
    const held = me(["engagement.manage"]);
    const hook = render({ me: held, hrefs: HREFS, path: "/wheel/settings" });
    hook.rerender({ me: held, hrefs: ["/dashboard"], path: "/wheel/settings" });
    expect(hook.result.current).toBe(false);
  });

  it("a page no entry owns is left to its own guard", () => {
    const hook = render({ me: me(["x"]), hrefs: ["/dashboard"], path: "/somewhere" });
    hook.rerender({ me: me([]), hrefs: [], path: "/somewhere" });
    expect(hook.result.current).toBe(false);
  });
});
