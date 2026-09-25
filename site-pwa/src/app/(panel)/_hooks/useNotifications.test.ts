import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useNotifications } from "./useNotifications";
import { usePanelSession } from "../_context/PanelSessionContext";
import { usePanelRealtime } from "../_context/PanelRealtimeContext";
import { notificationApi } from "@/lib/notification-api";
import { userChannel } from "@/lib/realtime";
import { RealtimeEvents } from "@/generated/wire";

/**
 * The notifications dropdown's data (F-093-h), and the two things about it that
 * have to be true:
 *
 * > **The badge is `notification-service`'s `unreadCount`, never a number this
 * > app counted**, and
 * > **only `notification.created` is a reason to ask again** — the `user:`
 * > channel also carries payment events (F-067-l/m).
 *
 * The first is the same correction `useWalletBalance` exists for: legacy kept
 * counts in a client store and let components adjust them. `unreadCount` is
 * over the *whole* inbox whatever the page or filter
 * (`domains/notification/contract.md`), so a count taken from the rendered page
 * would be wrong for every user with more than one page of unread rows — and
 * wrong in the direction that hides mail.
 *
 * The second is the difference from the wallet, whose rule is the opposite: it
 * re-reads on *any* event because no payment shape was agreed when it shipped.
 * Here the shape is agreed (`automation/contract.outbox.md`, "the third
 * consumer"), so the filter is cheap and a payment no longer costs an inbox
 * read.
 */

vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("../_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));
vi.mock("@/lib/notification-api", () => ({
  notificationApi: { inbox: vi.fn(), markRead: vi.fn() },
}));

const session = vi.mocked(usePanelSession);
const realtime = vi.mocked(usePanelRealtime);
const inbox = vi.mocked(notificationApi.inbox);
const markRead = vi.mocked(notificationApi.markRead);

/** A stand-in for `RealtimeClient`; the transport has its own spec. */
function fakeClient() {
  const listeners: Array<(payload: unknown) => void> = [];
  const missed: Array<() => void> = [];
  const unsubscribe = vi.fn();
  return {
    channels: [] as string[],
    listeners,
    missed,
    unsubscribe,
    subscribe: vi.fn((channel: string, options: { onMessage: (p: unknown) => void; onMissed?: () => void }) => {
      client.channels.push(channel);
      listeners.push(options.onMessage);
      if (options.onMissed) missed.push(options.onMissed);
      return unsubscribe;
    }),
  };
}
let client: ReturnType<typeof fakeClient>;

function signedInAs(userId: string | null) {
  session.mockReturnValue({
    me: null,
    group: userId ? ({ current: { userId } } as never) : null,
    isLoading: false,
    reload: vi.fn(),
  });
}

function page(over: Partial<{ items: unknown[]; unreadCount: number; total: number }> = {}) {
  return {
    items: [
      { id: "n1", type: "admin_message", title: "t", body: "b", readAt: null, createdAt: "2026-09-20T10:00:00.000Z" },
    ],
    page: 1,
    pageSize: 10,
    total: 1,
    unreadCount: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  client = fakeClient();
  realtime.mockReturnValue(client as never);
  signedInAs("user-1");
  inbox.mockResolvedValue(page() as never);
  markRead.mockResolvedValue({ marked: 1, unreadCount: 0 } as never);
});

describe("useNotifications", () => {
  it("shows the count the service answered, not one counted from the page", async () => {
    // Two unread rows exist; only one of them is on the page this dropdown reads.
    inbox.mockResolvedValue(page({ unreadCount: 7, total: 7 }) as never);
    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.unreadCount).toBe(7);
  });

  it("asks again when a notification arrives, and ignores the channel's other events", async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(1));
    expect(client.channels).toEqual([userChannel("user-1")]);

    // A payment event shares this channel (F-067-l). It is not an inbox row.
    act(() => client.listeners.forEach((l) => l({ type: RealtimeEvents.paymentConfirmed, paymentId: "p1" })));
    await Promise.resolve();
    expect(inbox).toHaveBeenCalledTimes(1);

    act(() =>
      client.listeners.forEach((l) =>
        l({ type: RealtimeEvents.notificationCreated, userId: "user-1", notification: { id: "n2" } }),
      ),
    );
    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(2));
  });

  it("re-reads after a reconnect, since a notification told while the socket was down reached nobody", async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(1));

    await act(async () => client.missed.forEach((onMissed) => onMissed()));

    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(2));
    expect(result.current.failed).toBe(false);
  });

  it("takes the new count from the mark-read answer and re-reads the page", async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    inbox.mockResolvedValue(page({ unreadCount: 0 }) as never);
    await act(async () => {
      await result.current.markAllRead();
    });

    expect(markRead).toHaveBeenCalledWith(undefined);
    expect(result.current.unreadCount).toBe(0);
    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(2));
  });

  it("keeps the last good page when a read fails, and says so", async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    inbox.mockRejectedValue(new Error("offline"));
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.failed).toBe(true));
    // A failed read is not an empty inbox: an empty state here would read as
    // "you have no messages", which is a different and wrong sentence.
    expect(result.current.items).toHaveLength(1);
    expect(result.current.unreadCount).toBe(1);
  });

  it("opens no socket and reads nothing before there is an account", async () => {
    signedInAs(null);
    const { result } = renderHook(() => useNotifications());

    expect(inbox).not.toHaveBeenCalled();
    expect(client.subscribe).not.toHaveBeenCalled();
    expect(result.current.unreadCount).toBe(0);
  });
});
