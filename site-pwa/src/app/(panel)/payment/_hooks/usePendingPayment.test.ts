import { RealtimeEvents } from "@/generated/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePendingPayment } from "./usePendingPayment";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { billingApi } from "@/lib/billing-api";
import { userChannel } from "@/lib/realtime";

/**
 * `/payment/pending` hears its payment close instead of polling (RT-1-c, C-14).
 * The event is `billing.wallet.changed` on the payer's `user:`: every credit and
 * every reversal writes it, while `payment.confirmed` / `reversed` never reach
 * live push. A payment that closes without credit has no event, so a tab
 * becoming visible asks again too.
 */

vi.mock("../../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("../../_context/PanelRealtimeContext", () => ({ usePanelRealtime: vi.fn() }));
vi.mock("@/lib/billing-api", () => ({ billingApi: { walletPayment: vi.fn() } }));

const walletPayment = vi.mocked(billingApi.walletPayment);
const listeners: Array<(payload: unknown) => void> = [];
const channels: string[] = [];
const client = {
  subscribe: vi.fn((channel: string, options: { onMessage: (p: unknown) => void }) => {
    channels.push(channel);
    listeners.push(options.onMessage);
    return () => listeners.splice(listeners.indexOf(options.onMessage), 1);
  }),
};
const pending = { status: "pending" } as never;
const credited = { status: "success", referenceId: "REF1" } as never;

function emit(type: string) {
  act(() => listeners.forEach((l) => l({ type })));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  listeners.length = 0;
  channels.length = 0;
  vi.mocked(usePanelSession).mockReturnValue({ group: { current: { userId: "u-1" } } } as never);
  vi.mocked(usePanelRealtime).mockReturnValue(client as never);
  walletPayment.mockResolvedValue(pending);
});

describe("usePendingPayment", () => {
  it("reads once on mount and never polls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => usePendingPayment("p-1"));
    await waitFor(() => expect(walletPayment).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(walletPayment).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ kind: "waiting" });
  });

  it("re-reads on billing.wallet.changed on the payer's channel, and turns credited", async () => {
    const { result } = renderHook(() => usePendingPayment("p-1"));
    await waitFor(() => expect(walletPayment).toHaveBeenCalledTimes(1));
    expect(channels).toContain(userChannel("u-1"));
    walletPayment.mockResolvedValue(credited);
    emit(RealtimeEvents.walletChanged);
    await waitFor(() => expect(result.current).toEqual({ kind: "credited", reference: "REF1" }));
    expect(walletPayment).toHaveBeenCalledWith("p-1");
  });

  it("ignores other events on the channel", async () => {
    renderHook(() => usePendingPayment("p-1"));
    await waitFor(() => expect(walletPayment).toHaveBeenCalledTimes(1));
    emit(RealtimeEvents.notificationCreated);
    await act(async () => {});
    expect(walletPayment).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the tab becomes visible: a close with no credit has no event", async () => {
    renderHook(() => usePendingPayment("p-1"));
    await waitFor(() => expect(walletPayment).toHaveBeenCalledTimes(1));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(walletPayment).toHaveBeenCalledTimes(2));
  });

  it("stops listening once the payment has an outcome", async () => {
    walletPayment.mockResolvedValue(credited);
    const { result } = renderHook(() => usePendingPayment("p-1"));
    await waitFor(() => expect(result.current.kind).toBe("credited"));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    emit(RealtimeEvents.walletChanged);
    await act(async () => {});
    expect(walletPayment).toHaveBeenCalledTimes(1);
  });
});
