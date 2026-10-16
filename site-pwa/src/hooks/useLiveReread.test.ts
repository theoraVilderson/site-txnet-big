import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLiveReread } from "./useLiveReread";
import { usePanelRealtime } from "@/app/(panel)/_context/PanelRealtimeContext";
import { LIVE_REREAD_MS } from "@/lib/realtime";

/**
 * The one way a page re-reads on a live event (RT-1-a,
 * `realtime/contract.live-events.md`): filter by type, throttle the reads
 * (F-067-p), re-read after a reconnect, and leave nothing subscribed behind.
 */

vi.mock("@/app/(panel)/_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));

const realtime = vi.mocked(usePanelRealtime);

function fakeClient() {
  const fake = {
    channels: [] as string[],
    onMessage: null as ((payload: unknown) => void) | null,
    onMissed: null as (() => void) | null,
    unsubscribe: vi.fn(),
    subscribe: vi.fn((channel: string, options: { onMessage: (p: unknown) => void; onMissed?: () => void }) => {
      fake.channels.push(channel);
      fake.onMessage = options.onMessage;
      fake.onMissed = options.onMissed ?? null;
      return fake.unsubscribe;
    }),
  };
  return fake;
}
let client: ReturnType<typeof fakeClient>;

beforeEach(() => {
  vi.useFakeTimers();
  client = fakeClient();
  realtime.mockReturnValue(client as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLiveReread", () => {
  it("re-reads on a listed type and ignores every other", () => {
    const reread = vi.fn();
    renderHook(() => useLiveReread("tenant:t-1", ["tenant.domain.changed"], reread));
    expect(client.channels).toEqual(["tenant:t-1"]);

    client.onMessage!({ type: "network.panel.tested" });
    client.onMessage!("not an object");
    expect(reread).not.toHaveBeenCalled();

    client.onMessage!({ type: "tenant.domain.changed", domainId: "d-1" });
    expect(reread).toHaveBeenCalledTimes(1);
    expect(reread).toHaveBeenCalledWith("event");
  });

  it("narrows a shared channel to the subject on screen with `accepts` (F-1001-p)", () => {
    const reread = vi.fn();
    renderHook(() => useLiveReread("tenant:p-1", ["billing.analytics.reseller_refreshed"], reread, (p) => p.resellerId === "r-1"));
    client.onMessage!({ type: "billing.analytics.reseller_refreshed", resellerId: "r-2" });
    expect(reread).not.toHaveBeenCalled();
    client.onMessage!({ type: "billing.analytics.reseller_refreshed", resellerId: "r-1" });
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("a burst of five makes two reads: one now, one at the end of the window", () => {
    const reread = vi.fn();
    renderHook(() => useLiveReread("tenant:t-1", ["x"], reread));
    for (let i = 0; i < 5; i++) client.onMessage!({ type: "x" });
    expect(reread).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LIVE_REREAD_MS);
    expect(reread).toHaveBeenCalledTimes(2);
  });

  it("re-reads after a reconnect, and says so", () => {
    const reread = vi.fn();
    renderHook(() => useLiveReread("user:u-1", ["x"], reread));
    client.onMissed!();
    expect(reread).toHaveBeenCalledWith("missed");
  });

  it("a window that held an event reads as an event, though a reconnect came last", () => {
    const reread = vi.fn();
    renderHook(() => useLiveReread("user:u-1", ["x"], reread));
    client.onMissed!();
    client.onMessage!({ type: "x" });
    client.onMissed!();
    vi.advanceTimersByTime(LIVE_REREAD_MS);
    expect(reread.mock.calls).toEqual([["missed"], ["event"]]);
  });

  it('"any" re-reads on every event on the channel', () => {
    const reread = vi.fn();
    renderHook(() => useLiveReread("user:u-1", "any", reread));
    client.onMessage!({ type: "whatever" });
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("never subscribes with a null channel, or with no socket", () => {
    renderHook(() => useLiveReread(null, ["x"], vi.fn()));
    expect(client.subscribe).not.toHaveBeenCalled();
    realtime.mockReturnValue(null);
    renderHook(() => useLiveReread("user:u-1", ["x"], vi.fn()));
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it("calls the latest reread without resubscribing when it changes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useLiveReread("user:u-1", ["x"], fn), { initialProps: { fn: first } });
    rerender({ fn: second });
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    client.onMessage!({ type: "x" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("unmount unsubscribes and drops a read still owed", () => {
    const reread = vi.fn();
    const { unmount } = renderHook(() => useLiveReread("user:u-1", ["x"], reread));
    client.onMessage!({ type: "x" });
    client.onMessage!({ type: "x" });
    unmount();
    expect(client.unsubscribe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LIVE_REREAD_MS);
    expect(reread).toHaveBeenCalledTimes(1);
  });
});
