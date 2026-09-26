import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { RealtimeEvents } from "@/generated/wire";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { userChannel } from "@/lib/realtime";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { useGrantsPage } from "./useGrantsPage";

/**
 * A purchase's last step, seen from "my services" (F-111-f):
 *
 * > **A paid Grant is `pending` until delivery, and an open page turns it
 * > live when delivery finishes** — by asking billing again, never by
 * > writing `active` into the row itself.
 *
 * The event is `entitlement.grant.delivered` or `.refunded` on the buyer's
 * `user:` channel (`automation/contract.outbox.md`, "A purchase's end, told").
 * The row is re-read rather than patched because delivery also sets the
 * period, and a refund ends in a status this page did not predict; the
 * payload is a nudge, billing's answer is the row (D-15).
 *
 * The re-read is quiet: a skeleton over a list the user is reading, because
 * one row on it changed, would be worse than the wait it replaced.
 */

vi.mock("../../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("../../_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { grants: vi.fn() },
}));
vi.mock("@/lib/catalog-api", () => ({ catalogApi: { texts: vi.fn() } }));

const session = vi.mocked(usePanelSession);
const realtime = vi.mocked(usePanelRealtime);
const grants = vi.mocked(billingApi.grants);

const ROW: GrantRow = {
  id: "g1",
  status: "pending",
  startsAt: "2026-09-25T00:00:00.000Z",
  endsAt: null,
  featureKeys: [],
  variant: { id: "v1", sku: "VPN_PRO-30D", nameKey: "catalog.product.vpn.name" },
  billingMode: "prepaid",
  consumedBytes: "0",
  purchasedBytes: "0",
  suspendedAt: null,
  purgeAt: null,
};

const page = (...rows: Partial<GrantRow>[]) => ({
  rows: rows.map((r) => ({ ...ROW, ...r })),
  total: rows.length,
  page: 1,
  pageSize: 20,
});

/** A stand-in for `RealtimeClient`; the transport has its own spec. */
function fakeClient() {
  const listeners: Array<(payload: unknown) => void> = [];
  const missed: Array<() => void> = [];
  return {
    channels: [] as string[],
    listeners,
    missed,
    /** `null` is a socket that is not live — never welcomed, or dropped. */
    live: null as null | { connectionId: string; userId: string | null },
    connectionInfo: vi.fn(() => client.live),
    subscribe: vi.fn((channel: string, options: { onMessage: (p: unknown) => void; onMissed?: () => void }) => {
      client.channels.push(channel);
      listeners.push(options.onMessage);
      if (options.onMissed) missed.push(options.onMissed);
      return vi.fn();
    }),
  };
}
let client: ReturnType<typeof fakeClient>;

const hear = (payload: unknown) =>
  act(async () => {
    for (const onMessage of client.listeners) onMessage(payload);
  });

beforeEach(() => {
  vi.clearAllMocks();
  client = fakeClient();
  session.mockReturnValue({ me: null, group: { current: { userId: "u-1" } } as never, isLoading: false, reload: vi.fn() });
  realtime.mockReturnValue(client as never);
  vi.mocked(catalogApi.texts).mockResolvedValue({} as never);
  grants.mockResolvedValue(page({ id: "g1" }, { id: "g2", status: "active" }) as never);
});

describe("useGrantsPage — a pending Grant turning live (F-111-f)", () => {
  it("re-reads quietly when a pending Grant on the page is delivered", async () => {
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows?.[0].status).toBe("pending"));
    expect(client.channels).toEqual([userChannel("u-1")]);

    grants.mockResolvedValue(page({ id: "g1", status: "active", endsAt: "2026-10-25T00:00:00.000Z" }) as never);
    await hear({ type: RealtimeEvents.grantDelivered, grantId: "g1" });

    // No skeleton over the list while the one row is fetched again.
    expect(result.current.isLoading).toBe(false);
    await waitFor(() => expect(result.current.rows?.[0].status).toBe("active"));
    expect(result.current.rows?.[0].endsAt).toBe("2026-10-25T00:00:00.000Z");
    expect(grants).toHaveBeenCalledTimes(2);
  });

  it("re-reads on a refund too — the row ends in whatever billing says", async () => {
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows).not.toBeNull());

    grants.mockResolvedValue(page({ id: "g1", status: "cancelled" }) as never);
    await hear({ type: RealtimeEvents.grantRefunded, grantId: "g1", invoiceId: "i1", amount: "10.00" });

    await waitFor(() => expect(result.current.rows?.[0].status).toBe("cancelled"));
  });

  it("asks nothing for a Grant it is not showing as pending, or for another event", async () => {
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows).not.toBeNull());

    await hear({ type: RealtimeEvents.grantDelivered, grantId: "g2" }); // already active here
    await hear({ type: RealtimeEvents.grantDelivered, grantId: "g-elsewhere" }); // another page's
    await hear({ type: RealtimeEvents.paymentConfirmed, paymentId: "p1", amountCredited: "5.00" });
    await hear({ type: RealtimeEvents.grantDelivered }); // no grantId: whose it is is never guessed

    expect(grants).toHaveBeenCalledTimes(1);
  });

  it("keeps the rows it has when the quiet re-read fails", async () => {
    // The event was a hint, not the record: a failed hint leaves billing's
    // last answer on screen rather than blanking a page that was right.
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows).not.toBeNull());

    grants.mockRejectedValue(new Error("down"));
    await hear({ type: RealtimeEvents.grantDelivered, grantId: "g1" });

    await waitFor(() => expect(grants).toHaveBeenCalledTimes(2));
    expect(result.current.rows?.[0].status).toBe("pending");
    expect(result.current.error).toBeNull();
  });

  it("re-reads after a reconnect while a Grant is pending — the event may have been sent to nobody", async () => {
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows?.[0].status).toBe("pending"));

    grants.mockResolvedValue(page({ id: "g1", status: "active" }) as never);
    await act(async () => {
      for (const onMissed of client.missed) onMissed();
    });

    expect(result.current.isLoading).toBe(false);
    await waitFor(() => expect(result.current.rows?.[0].status).toBe("active"));
  });

  it("asks nothing after a reconnect when nothing on the page is pending", async () => {
    grants.mockResolvedValue(page({ id: "g2", status: "active" }) as never);
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows).not.toBeNull());

    await act(async () => {
      for (const onMissed of client.missed) onMissed();
    });

    expect(grants).toHaveBeenCalledTimes(1);
  });

  it("asks nothing on any clock, even with the socket down — reconnecting is the socket's job", async () => {
    // F-111-l (user, 2026-09-26): no request is sent on a timer. A socket that
    // is down reconnects on its own backoff, and `onMissed` above re-reads once
    // it is back; until then the page shows billing's last answer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      realtime.mockReturnValue(null);
      const { result } = renderHook(() => useGrantsPage(1, "en"));
      await waitFor(() => expect(result.current.rows?.[0].status).toBe("pending"));

      await act(async () => {
        vi.advanceTimersByTime(10 * 60_000);
      });
      expect(grants).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reads the page with no socket at all", async () => {
    realtime.mockReturnValue(null);
    const { result } = renderHook(() => useGrantsPage(1, "en"));

    await waitFor(() => expect(result.current.rows?.length).toBe(2));
    expect(client.subscribe).not.toHaveBeenCalled();
  });
});

describe("useGrantsPage — a Grant's configs ready (F-111-l)", () => {
  // `network.grant.linksCaptured` says a config's lines exist now — a minute or
  // two after "delivered" turned the row active. The lines are in the config
  // list a row opens (`GrantConfigs`), not in this page's rows, so the event
  // asks nothing here: it bumps that Grant's counter, and an open list re-reads.
  it("bumps the named Grant's configs whatever its status, and reads no list", async () => {
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows).not.toBeNull());
    expect(result.current.configsAsked).toEqual({});

    await hear({ type: RealtimeEvents.grantLinksCaptured, grantId: "g2" });
    await hear({ type: RealtimeEvents.grantLinksCaptured, grantId: "g2" });

    expect(result.current.configsAsked).toEqual({ g2: 2 });
    expect(grants).toHaveBeenCalledTimes(1);
  });

  it("bumps nothing for a Grant not on the page, or with no grantId", async () => {
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows).not.toBeNull());

    await hear({ type: RealtimeEvents.grantLinksCaptured, grantId: "elsewhere" });
    await hear({ type: RealtimeEvents.grantLinksCaptured });

    expect(result.current.configsAsked).toEqual({});
  });

  it("bumps every row's configs after a reconnect — a capture may have been sent to nobody", async () => {
    const { result } = renderHook(() => useGrantsPage(1, "en"));
    await waitFor(() => expect(result.current.rows).not.toBeNull());

    await act(async () => {
      for (const onMissed of client.missed) onMissed();
    });

    expect(result.current.configsAsked).toEqual({ g1: 1, g2: 1 });
  });
});
