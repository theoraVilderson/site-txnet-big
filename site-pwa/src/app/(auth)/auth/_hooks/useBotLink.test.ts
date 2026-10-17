import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useBotLink } from "./useBotLink";
import { authApi } from "@/lib/auth-api";
import { createRealtimeClient } from "@/lib/realtime";

vi.mock("@/lib/auth-api", () => ({
  authApi: { botLinkStatus: vi.fn() },
}));

vi.mock("@/lib/realtime", () => ({
  createRealtimeClient: vi.fn(),
}));

const status = vi.mocked(authApi.botLinkStatus);
const makeClient = vi.mocked(createRealtimeClient);

const link = {
  accepted: true as const,
  linkRequired: true as const,
  platform: "telegram" as const,
  linkToken: "lt1",
  deepLink: "https://t.me/txbot?start=lt1",
  expiresIn: 900,
  channel: "otp:c1",
  channelToken: "tok1",
};

/** A stand-in for `RealtimeClient`: the transport has its own spec (`lib/realtime.test.ts`). */
function fakeClient() {
  const client = {
    connect: vi.fn(),
    close: vi.fn(),
    unsubscribe: vi.fn(),
    subscribe: vi.fn(),
    listener: null as null | { proof?: string; onMessage: (payload: unknown) => void; onMissed?: () => void },
  };
  client.subscribe.mockImplementation((_channel: string, options: never) => {
    client.listener = options;
    return client.unsubscribe;
  });
  return client;
}

let client: ReturnType<typeof fakeClient>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  client = fakeClient();
  makeClient.mockReturnValue(client as never);
  status.mockResolvedValue({ state: "pending", otpSent: false } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/**
 * The screen waits while the user is in the messenger (RT-1-h). It hears the
 * link's `otp:` channel and re-reads the status route — once on mount, once
 * per frame, once after a missed window — and never on a timer (C-14).
 */
describe("waiting on a messenger link", () => {
  it("subscribes to the link's channel with its proof and reads the status once", async () => {
    const { result } = renderHook(() => useBotLink(() => {}));
    act(() => result.current.start(link));

    await waitFor(() => expect(client.subscribe).toHaveBeenCalled());
    expect(client.subscribe.mock.calls[0][0]).toBe("otp:c1");
    expect(client.subscribe.mock.calls[0][1]).toMatchObject({ proof: "tok1" });
    await waitFor(() => expect(status).toHaveBeenCalledWith("lt1"));
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("does not poll: no read while nothing is heard", async () => {
    const { result } = renderHook(() => useBotLink(() => {}));
    act(() => result.current.start(link));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(status).toHaveBeenCalledTimes(1);
  });

  it("re-reads on a frame and on a missed window, and moves on once the record says linked", async () => {
    const onLinked = vi.fn();
    const { result } = renderHook(() => useBotLink(onLinked));
    act(() => result.current.start(link));
    await waitFor(() => expect(client.listener).not.toBeNull());
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));

    act(() => client.listener!.onMissed?.());
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(onLinked).not.toHaveBeenCalled();

    status.mockResolvedValue({ state: "linked", otpSent: true } as never);
    act(() => client.listener!.onMessage({ state: "linked", otpSent: true }));

    await waitFor(() => expect(onLinked).toHaveBeenCalledWith({ state: "linked", otpSent: true }));
    expect(result.current.status).toEqual({ state: "linked", otpSent: true });
  });

  it("closes the socket on reset", async () => {
    const { result } = renderHook(() => useBotLink(() => {}));
    act(() => result.current.start(link));
    await waitFor(() => expect(client.subscribe).toHaveBeenCalled());

    act(() => result.current.reset());

    expect(client.unsubscribe).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });
});
