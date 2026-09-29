import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWalletBalance } from "./useWalletBalance";
import { usePanelSession } from "../_context/PanelSessionContext";
import { usePanelRealtime } from "../_context/PanelRealtimeContext";
import { billingApi } from "@/lib/billing-api";
import { userChannel } from "@/lib/realtime";

/**
 * The wallet balance in the top bar (F-093-c), and the one thing about it that
 * has to be true:
 *
 * > **This app never computes a balance. It displays what billing last
 * > answered, and an event makes it ask again.**
 *
 * Legacy kept the balance as a number in a client store and let any component
 * adjust it (`useAuthStore.updateUser`). The gift-code modal added
 * `data.amount` to it on *every* answer including a refusal, where `amount` is
 * undefined — so a failed redemption showed success and a balance of `NaN`
 * (`F-093-g`'s note). The same store is why `F-092-n` exists at all: the
 * financial page walked a balance backwards over rows it had skipped, counting
 * failed attempts as movements.
 *
 * So the second case below is the whole point of this file. The payload of a
 * payment event is deliberately *not read*: the hook re-reads the route, and
 * `wallet.cachedBalance` is written only inside the transaction that appends
 * the proving ledger row (`billing/contract.history.md`, invariant 1). That
 * also means there is no event shape to guess — `F-092-j` is the row that will
 * publish one, and nothing here has to change when it lands.
 */

vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("../_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));
vi.mock("@/lib/billing-api", () => ({
  billingApi: { walletBalance: vi.fn() },
}));

const session = vi.mocked(usePanelSession);
const realtime = vi.mocked(usePanelRealtime);
const walletBalance = vi.mocked(billingApi.walletBalance);

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

beforeEach(() => {
  vi.clearAllMocks();
  client = fakeClient();
  signedInAs("u-1");
  realtime.mockReturnValue(client as never);
  walletBalance.mockResolvedValue({ balance: "12.34", held: "0.00", available: "12.34", currencyCode: "USD" });
});

describe("useWalletBalance", () => {
  it("shows the decimal string billing answered, untouched", async () => {
    const { result } = renderHook(() => useWalletBalance());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // The exact string, not a number: the amount stays a decimal string from
    // API to glyph (`contract.kit.md` rule 2), and `0.10` parsed and reprinted
    // is the first place a float creeps in.
    expect(result.current.balance).toBe("12.34");
    expect(result.current.failed).toBe(false);
    expect(walletBalance).toHaveBeenCalledTimes(1);
  });

  it("re-reads on a wallet event and never adds the payload to the balance", async () => {
    const { result } = renderHook(() => useWalletBalance());
    await waitFor(() => expect(result.current.balance).toBe("12.34"));

    expect(client.channels).toEqual([userChannel("u-1")]);

    // The event legacy would have done arithmetic with. `amount` is here on
    // purpose: a hook that reads it passes this assertion only by accident, and
    // a hook that reads a *missing* one produces `NaN` — the shipped bug.
    walletBalance.mockResolvedValue({ balance: "62.34", held: "0.00", available: "62.34", currencyCode: "USD" });
    await act(async () => {
      for (const onMessage of client.listeners) {
        onMessage({ type: "payment.succeeded", amount: 50 });
      }
    });

    await waitFor(() => expect(result.current.balance).toBe("62.34"));
    expect(walletBalance).toHaveBeenCalledTimes(2);
  });

  it("re-reads after a reconnect, since a payment told while the socket was down reached nobody", async () => {
    const { result } = renderHook(() => useWalletBalance());
    await waitFor(() => expect(result.current.balance).toBe("12.34"));

    walletBalance.mockResolvedValue({ balance: "62.34", held: "0.00", available: "62.34", currencyCode: "USD" });
    await act(async () => client.missed.forEach((onMissed) => onMissed()));

    await waitFor(() => expect(result.current.balance).toBe("62.34"));
    expect(walletBalance).toHaveBeenCalledTimes(2);
  });

  it("reads the balance when the deployment has no socket at all", async () => {
    // `usePanelRealtime()` is null before the session is established and on a
    // deployment with no gateway configured (`contract.realtime.md`). A balance
    // that only appeared for socket-bearing deployments would be missing on the
    // ones least likely to be watched.
    realtime.mockReturnValue(null);
    const { result } = renderHook(() => useWalletBalance());

    await waitFor(() => expect(result.current.balance).toBe("12.34"));
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it("asks nothing until there is a session", async () => {
    // An anonymous read is a 401 the user never sees, and `X-User-Id` is what
    // decides whose wallet is read — there is no id in the query to fall back
    // on (`billing/contract.history.md`).
    signedInAs(null);
    const { result } = renderHook(() => useWalletBalance());

    expect(walletBalance).not.toHaveBeenCalled();
    expect(result.current.balance).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("reports a failed read instead of showing a zero", async () => {
    // Zero is a real balance — a user with no wallet is `"0.00"`, not a 404 —
    // so a failed read must not render as one.
    walletBalance.mockRejectedValue(new Error("unreachable"));
    const { result } = renderHook(() => useWalletBalance());

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.balance).toBeNull();
  });
});
