import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  RealtimeClient,
  SUBPROTOCOL,
  type RealtimeSocket,
} from "./realtime";

/**
 * The transport half of `F-070-a` — what every screen that wants a live
 * update sits on (`docs/interfaces/panel-web/contract.realtime.md`).
 *
 * The three things covered here are the ones that fail *silently*. A socket
 * that never opens is obvious the first time anyone tries it; these are not:
 *
 * - **A proof-bearing channel is never resumed** (`realtime/contract.md`). The
 *   `resume` frame carries no proofs, so an `otp:` channel comes back in
 *   `refused` and has to be re-subscribed with the proof the page is still
 *   holding. Get it wrong and the OTP result stops arriving after one network
 *   blip, on a screen that shows no error because nothing errored.
 * - **`4401` is a sign-out, not a reconnect.** Reconnecting on it turns a
 *   revoked session into a loop against the gateway.
 * - **The subscription cap is counted here.** Learning about it by being
 *   refused means the refusal arrives after the screen already rendered.
 */

class FakeSocket implements RealtimeSocket {
  static live: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.live.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }

  /** The 101 landed. */
  accept() {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** A server frame arrives. */
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The server (or the network) took it away. */
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

const HEARTBEAT_MS = 30_000;

function welcome(socket: FakeSocket, over: Record<string, unknown> = {}) {
  socket.emit({
    type: "welcome",
    connectionId: "c1",
    userId: null,
    heartbeatMs: HEARTBEAT_MS,
    maxSubscriptions: 32,
    ...over,
  });
}

/** Open a client whose socket is accepted and welcomed. */
function connected(options: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  const client = new RealtimeClient({
    url: "wss://api.example.test/realtime",
    socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    ...options,
  });
  client.connect();
  const socket = FakeSocket.live.at(-1)!;
  socket.accept();
  welcome(socket);
  return { client, socket };
}

beforeEach(() => {
  FakeSocket.live = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("opening the connection", () => {
  it("offers the credential as the second subprotocol, and only that", () => {
    const client = new RealtimeClient({
      url: "wss://api.example.test/realtime",
      credential: () => "access-token",
      socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    });
    client.connect();

    expect(FakeSocket.live[0].protocols).toEqual([SUBPROTOCOL, "access-token"]);
  });

  it("connects anonymously when there is no credential", () => {
    const client = new RealtimeClient({
      url: "wss://api.example.test/realtime",
      credential: () => null,
      socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    });
    client.connect();

    expect(FakeSocket.live[0].protocols).toEqual([SUBPROTOCOL]);
  });
});

describe("subscribing", () => {
  it("holds a subscription until the welcome frame, then sends it", () => {
    const client = new RealtimeClient({
      url: "wss://api.example.test/realtime",
      socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    });
    client.connect();
    const socket = FakeSocket.live[0];
    socket.accept();
    client.subscribe("otp:abc", { proof: "tok", onMessage: () => {} });

    expect(socket.frames()).toEqual([]);

    welcome(socket);

    expect(socket.frames()).toEqual([
      { type: "subscribe", channel: "otp:abc", proof: "tok" },
    ]);
  });

  it("delivers a message only to the channel's own listeners", () => {
    const { client, socket } = connected();
    const otp = vi.fn();
    const other = vi.fn();
    client.subscribe("otp:abc", { proof: "tok", onMessage: otp });
    client.subscribe("user:u1", { onMessage: other });

    socket.emit({ type: "message", channel: "otp:abc", payload: { status: "sent" } });

    expect(otp).toHaveBeenCalledWith({ status: "sent" });
    expect(other).not.toHaveBeenCalled();
  });

  it("counts the cap itself instead of waiting to be refused", () => {
    const client = new RealtimeClient({
      url: "wss://api.example.test/realtime",
      socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    });
    client.connect();
    const socket = FakeSocket.live[0];
    socket.accept();
    welcome(socket, { maxSubscriptions: 2 });

    client.subscribe("user:u1", { onMessage: () => {} });
    client.subscribe("tenant:t1", { onMessage: () => {} });
    const refused = vi.fn();
    const stop = client.subscribe("otp:abc", { proof: "tok", onMessage: () => {}, onError: refused });

    expect(refused).toHaveBeenCalledWith("realtime.subscriptionLimit");
    expect(socket.frames().filter((f) => f.type === "subscribe")).toHaveLength(2);
    // The refusal is local, so the returned handle must still be safe to call.
    expect(() => stop()).not.toThrow();
  });

  it("stops the server subscription when the last listener leaves", () => {
    const { client, socket } = connected();
    const first = client.subscribe("user:u1", { onMessage: () => {} });
    const second = client.subscribe("user:u1", { onMessage: () => {} });

    first();
    expect(socket.frames().some((f) => f.type === "unsubscribe")).toBe(false);

    second();
    expect(socket.frames().at(-1)).toEqual({ type: "unsubscribe", channel: "user:u1" });
  });
});

describe("reconnecting", () => {
  it("declares the resumable channels and re-proves the ones carrying a proof", () => {
    const { client, socket } = connected();
    client.subscribe("user:u1", { onMessage: () => {} });
    client.subscribe("otp:abc", { proof: "tok", onMessage: () => {} });

    socket.drop(4408);
    vi.advanceTimersByTime(60_000);

    const next = FakeSocket.live.at(-1)!;
    expect(next).not.toBe(socket);
    next.accept();
    welcome(next);

    expect(next.frames()).toEqual([
      { type: "resume", channels: ["user:u1"] },
      { type: "subscribe", channel: "otp:abc", proof: "tok" },
    ]);
  });

  it("re-subscribes a proof channel the server refused on resume", () => {
    const { client, socket } = connected();
    client.subscribe("otp:abc", { proof: "tok", onMessage: () => {} });
    socket.drop(4408);
    vi.advanceTimersByTime(60_000);
    const next = FakeSocket.live.at(-1)!;
    next.accept();
    welcome(next);
    next.sent = [];

    next.emit({ type: "resumed", channels: [], refused: ["otp:abc"] });

    expect(next.frames()).toEqual([
      { type: "subscribe", channel: "otp:abc", proof: "tok" },
    ]);
  });

  it("gives up on a channel the server refuses with no proof to re-prove it", () => {
    const { client, socket } = connected();
    const failed = vi.fn();
    client.subscribe("user:u1", { onMessage: () => {}, onError: failed });
    socket.drop(4408);
    vi.advanceTimersByTime(60_000);
    const next = FakeSocket.live.at(-1)!;
    next.accept();
    welcome(next);

    next.emit({ type: "resumed", channels: [], refused: ["user:u1"] });

    expect(failed).toHaveBeenCalledWith("realtime.channelForbidden");
    expect(client.channels()).toEqual([]);
  });

  it("treats 4401 as a sign-out and never reconnects", () => {
    const sessionLost = vi.fn();
    const { socket } = connected({ onSessionLost: sessionLost });

    socket.drop(4401);
    vi.advanceTimersByTime(600_000);

    expect(sessionLost).toHaveBeenCalledTimes(1);
    expect(FakeSocket.live).toHaveLength(1);
  });

  it("stops reconnecting once the caller closes it", () => {
    const { client, socket } = connected();

    client.close();
    socket.drop(1000);
    vi.advanceTimersByTime(600_000);

    expect(FakeSocket.live).toHaveLength(1);
  });

  it("drops a socket that has gone quiet past two heartbeats", () => {
    const { socket } = connected();

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(socket.frames().at(-1)).toEqual({ type: "ping" });

    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(socket.closedWith).not.toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.live.length).toBeGreaterThan(1);
  });
});
