import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useOtpDelivery } from "./useOtpDelivery";
import { authApi } from "@/lib/auth-api";
import { createRealtimeClient } from "@/lib/realtime";

vi.mock("@/lib/auth-api", () => ({
  authApi: { otpDeliveryStatus: vi.fn() },
}));

vi.mock("@/lib/realtime", () => ({
  createRealtimeClient: vi.fn(),
}));

const status = vi.mocked(authApi.otpDeliveryStatus);
const makeClient = vi.mocked(createRealtimeClient);

const handles = {
  deliveryId: "d1",
  channel: "otp:c1",
  channelToken: "tok1",
};

/**
 * A stand-in for `RealtimeClient` that lets a test push one frame. The real
 * transport has its own spec (`lib/realtime.test.ts`); what matters here is
 * which of the two answers — the push or the status route — the screen ends up
 * showing.
 */
function fakeClient() {
  const client = {
    connect: vi.fn(),
    close: vi.fn(),
    unsubscribe: vi.fn(),
    subscribe: vi.fn(),
    listener: null as null | {
      proof?: string;
      onMessage: (payload: unknown) => void;
      onError?: (code: string) => void;
    },
  };
  client.subscribe.mockImplementation((_channel: string, options: never) => {
    client.listener = options;
    return client.unsubscribe;
  });
  return client;
}

let client: ReturnType<typeof fakeClient>;

beforeEach(() => {
  client = fakeClient();
  makeClient.mockReturnValue(client as never);
  // A status read that never settles unless a test says otherwise: it must not
  // be what decides the assertions below.
  status.mockReturnValue(new Promise(() => {}) as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("before a code is requested", () => {
  it("holds no delivery and opens no socket", () => {
    const { result } = renderHook(() => useOtpDelivery());

    expect(result.current.delivery).toBeNull();
    expect(makeClient).not.toHaveBeenCalled();
  });
});

describe("once a 202 hands over its handles", () => {
  it("subscribes to the channel with the token as its proof", async () => {
    const { result } = renderHook(() => useOtpDelivery());

    act(() => result.current.start(handles));

    await waitFor(() => expect(client.subscribe).toHaveBeenCalled());
    expect(client.subscribe.mock.calls[0][0]).toBe("otp:c1");
    expect(client.subscribe.mock.calls[0][1]).toMatchObject({ proof: "tok1" });
    expect(client.connect).toHaveBeenCalled();
  });

  it("starts on queued — nothing has been decided yet", () => {
    const { result } = renderHook(() => useOtpDelivery());

    act(() => result.current.start(handles));

    expect(result.current.delivery).toEqual({ state: "queued" });
  });

  it("reads the status route once, because the push is at-most-once", async () => {
    const { result } = renderHook(() => useOtpDelivery());

    act(() => result.current.start(handles));

    await waitFor(() => expect(status).toHaveBeenCalledWith("d1"));
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("shows a pushed failure with the key the sender threw", async () => {
    const { result } = renderHook(() => useOtpDelivery());
    act(() => result.current.start(handles));
    await waitFor(() => expect(client.listener).not.toBeNull());

    act(() => client.listener!.onMessage({ state: "failed", failureKey: "otp.smsNotConfigured" }));

    expect(result.current.delivery).toEqual({
      state: "failed",
      failureKey: "otp.smsNotConfigured",
    });
  });
});

describe("the two answers disagreeing", () => {
  /**
   * The invariant this item turns on. `queued` is what the routes answer for a
   * number with no account behind it, and it is also what a slow provider
   * looks like — so it must never replace an end state the socket already
   * delivered, or a screen that heard "sent" would go back to waiting.
   */
  it("never moves back to queued once an end state has arrived", async () => {
    const settle = vi.fn();
    status.mockReturnValue(new Promise((resolve) => settle.mockImplementation(resolve)) as never);
    const { result } = renderHook(() => useOtpDelivery());
    act(() => result.current.start(handles));
    await waitFor(() => expect(client.listener).not.toBeNull());

    act(() => client.listener!.onMessage({ state: "sent" }));
    await act(async () => {
      settle({ state: "queued" });
      await Promise.resolve();
    });

    expect(result.current.delivery).toEqual({ state: "sent" });
  });

  it("takes the status route's end state when no push arrived", async () => {
    status.mockResolvedValue({ state: "failed", failureKey: "otp.deliveryFailed" } as never);
    const { result } = renderHook(() => useOtpDelivery());

    act(() => result.current.start(handles));

    await waitFor(() =>
      expect(result.current.delivery).toEqual({
        state: "failed",
        failureKey: "otp.deliveryFailed",
      }),
    );
  });

  it("ignores a frame that is not an end state", async () => {
    const { result } = renderHook(() => useOtpDelivery());
    act(() => result.current.start(handles));
    await waitFor(() => expect(client.listener).not.toBeNull());

    act(() => client.listener!.onMessage({ state: "nonsense" }));

    expect(result.current.delivery).toEqual({ state: "queued" });
  });
});

describe("a channel the gateway will not serve", () => {
  /**
   * An expired channel and one nobody ever minted are the same refusal
   * (`realtime/contract.channels.md`) — precisely so neither answers whether
   * the number has an account. Rendering it as a failure would put that answer
   * back on the screen.
   */
  it("stays on queued rather than showing the refusal", async () => {
    const { result } = renderHook(() => useOtpDelivery());
    act(() => result.current.start(handles));
    await waitFor(() => expect(client.listener).not.toBeNull());

    act(() => client.listener!.onError?.("realtime.channelForbidden"));

    expect(result.current.delivery).toEqual({ state: "queued" });
  });

  it("stays on queued when the status route cannot be reached", async () => {
    status.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useOtpDelivery());

    act(() => result.current.start(handles));

    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(result.current.delivery).toEqual({ state: "queued" });
  });
});

describe("leaving the step", () => {
  it("closes the socket on reset and forgets the delivery", async () => {
    const { result } = renderHook(() => useOtpDelivery());
    act(() => result.current.start(handles));
    await waitFor(() => expect(client.subscribe).toHaveBeenCalled());

    act(() => result.current.reset());

    expect(client.unsubscribe).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
    expect(result.current.delivery).toBeNull();
  });

  it("closes the socket when the screen unmounts", async () => {
    const { result, unmount } = renderHook(() => useOtpDelivery());
    act(() => result.current.start(handles));
    await waitFor(() => expect(client.subscribe).toHaveBeenCalled());

    unmount();

    expect(client.close).toHaveBeenCalled();
  });
});
