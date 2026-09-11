// One WebSocket for this page, multiplexed into channels — the browser half of
// `platform/realtime` (ADR-0030, ADR-0031). The rules it implements are in
// docs/interfaces/panel-web/contract.realtime.md; the frames it speaks are in
// docs/platform/realtime/contract.md. This module is the transport and nothing
// else: it knows no screen, no payload shape and no route.
import { REALTIME_URL } from "../env";

/**
 * The token rides in `Sec-WebSocket-Protocol` because it is the only header a
 * browser lets a page set on an upgrade (ADR-0030). The list is matched
 * exactly — `txnet.v1` first, the credential second — and the server selects
 * `txnet.v1`.
 */
export const SUBPROTOCOL = "txnet.v1";

/** Used until a `welcome` frame says otherwise; the gateway's own default. */
const DEFAULT_MAX_SUBSCRIPTIONS = 32;
const DEFAULT_HEARTBEAT_MS = 30_000;

/** `resume` takes at most 64 channels per frame (`realtime/contract.md`). */
const RESUME_MAX_CHANNELS = 64;

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
/** A `4429` means this user already holds every socket they may — start high. */
const BACKOFF_ATTEMPTS_AT_CAPACITY = 5;

/** Application close codes. 4000+ is the application range. */
export const CLOSE_SESSION_GONE = 4401;
export const CLOSE_HEARTBEAT = 4408;
export const CLOSE_TOO_MANY = 4429;
export const CLOSE_SHUTTING_DOWN = 4503;

/** Refusal codes a subscriber can be told about. Machine keys, never text. */
export type RealtimeErrorCode =
  | "realtime.channelUnknown"
  | "realtime.channelForbidden"
  | "realtime.subscriptionLimit"
  | "realtime.badFrame";

/** A refusal that ends a subscription rather than merely reporting on it. */
const FATAL_FOR_CHANNEL: readonly string[] = [
  "realtime.channelUnknown",
  "realtime.channelForbidden",
  "realtime.subscriptionLimit",
];

/**
 * The slice of `WebSocket` this client uses. Narrow on purpose: it is what
 * lets the spec drive the whole lifecycle without a server, and it documents
 * exactly which parts of the browser API are load-bearing here.
 */
export interface RealtimeSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => RealtimeSocket;

export type ChannelListener = {
  onMessage: (payload: unknown) => void;
  /** A refusal for this channel. The code is a key, not a sentence. */
  onError?: (code: RealtimeErrorCode) => void;
};

export type SubscribeOptions = ChannelListener & {
  /**
   * Required by, and only by, a channel no identity covers — today `otp:`.
   * Kept here for the life of the subscription because a reconnect has to
   * present it again: `resume` carries no proofs.
   */
  proof?: string;
};

export type RealtimeConnection = {
  connectionId: string;
  /** `null` on an anonymous connection — present-and-null, never missing. */
  userId: string | null;
};

export type RealtimeClientOptions = {
  /** Defaults to the deployment's socket URL (`env.ts`). */
  url?: string;
  /** Read on every connect, so a rotated access token is picked up. */
  credential?: () => string | null | undefined;
  /** The gateway closed with `4401`: the session is gone. Sign out. */
  onSessionLost?: () => void;
  /**
   * The socket closed before it was welcomed while a credential was offered.
   * A browser cannot see the `401` the gate answered — it sees a close with no
   * status — so this is the one hook that can refresh the token and let the
   * next attempt carry a live one. Called at most once per connect cycle.
   */
  onCredentialRejected?: () => void;
  socketFactory?: SocketFactory;
};

type ChannelEntry = {
  proof?: string;
  listeners: Set<ChannelListener>;
};

function defaultSocketFactory(url: string, protocols: string[]): RealtimeSocket {
  return new WebSocket(url, protocols) as unknown as RealtimeSocket;
}

/**
 * Holds one connection and the channels on it. Reconnect, heartbeat and
 * re-authorization are its whole job; deciding *when* a page should hold a
 * socket at all belongs to the screen that opens one.
 */
export class RealtimeClient {
  private readonly options: RealtimeClientOptions;
  private readonly subscriptions = new Map<string, ChannelEntry>();

  private socket: RealtimeSocket | null = null;
  private connection: RealtimeConnection | null = null;
  private welcomed = false;
  private stopped = false;
  private attempt = 0;
  private maxSubscriptions = DEFAULT_MAX_SUBSCRIPTIONS;
  private heartbeatMs = DEFAULT_HEARTBEAT_MS;
  private credentialOffered = false;
  private credentialRetried = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RealtimeClientOptions = {}) {
    this.options = options;
  }

  /** The channels this client believes it holds. */
  channels(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** What the `welcome` frame said, or `null` before one arrives. */
  connectionInfo(): RealtimeConnection | null {
    return this.connection;
  }

  connect(): void {
    this.stopped = false;
    if (this.socket) return;

    const url = this.options.url ?? REALTIME_URL;
    if (!url) return; // No socket configured for this deployment.

    const credential = this.options.credential?.() ?? null;
    this.credentialOffered = Boolean(credential);
    const protocols = credential ? [SUBPROTOCOL, credential] : [SUBPROTOCOL];

    const socket = (this.options.socketFactory ?? defaultSocketFactory)(url, protocols);
    this.socket = socket;
    this.welcomed = false;

    socket.onopen = () => {
      // Open is not ready: the `welcome` frame carries the limits, and a
      // subscribe sent before it would be counted against a cap we are only
      // guessing at.
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {
      // A browser reports an error and then a close; the close is where the
      // decision is made, so there is nothing to do twice.
    };
    socket.onclose = (event) => this.onClosed(event?.code ?? 1006);
  }

  /**
   * Subscribe to a channel and return the handle that leaves it. Several
   * listeners may share one channel; the server subscription ends when the
   * last of them goes. The cap counts channels, not listeners.
   */
  subscribe(channel: string, options: SubscribeOptions): () => void {
    const existing = this.subscriptions.get(channel);

    if (!existing && this.subscriptions.size >= this.maxSubscriptions) {
      // Counted here rather than learned from a refusal: by the time the
      // gateway answers, the screen that asked has already rendered.
      options.onError?.("realtime.subscriptionLimit");
      return () => {};
    }

    const listener: ChannelListener = { onMessage: options.onMessage, onError: options.onError };
    if (existing) {
      // A fresh proof supersedes the one held — the caller has just been
      // handed it, and the stored one may be the expired half of a retry.
      if (options.proof) existing.proof = options.proof;
      existing.listeners.add(listener);
    } else {
      this.subscriptions.set(channel, { proof: options.proof, listeners: new Set([listener]) });
      this.send({ type: "subscribe", channel, ...(options.proof ? { proof: options.proof } : {}) });
    }

    return () => this.removeListener(channel, listener);
  }

  /** Close for good. No reconnect follows, on any code. */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    this.connection = null;
    this.discard(socket);
    socket?.close(1000);
  }

  private removeListener(channel: string, listener: ChannelListener): void {
    const entry = this.subscriptions.get(channel);
    if (!entry || !entry.listeners.delete(listener)) return;
    if (entry.listeners.size > 0) return;
    this.subscriptions.delete(channel);
    this.send({ type: "unsubscribe", channel });
  }

  /** Let go of a socket without hearing from it again. */
  private discard(socket: RealtimeSocket | null): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.welcomed || !this.socket) return;
    this.socket.send(JSON.stringify(frame));
  }

  private receive(data: unknown): void {
    this.noteTraffic();

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return; // The server's frames are its own problem; a bad one is not ours.
    }
    if (!frame || typeof frame !== "object") return;

    switch (frame.type) {
      case "welcome":
        return this.onWelcome(frame);
      case "message":
        return this.onMessage(frame);
      case "resumed":
        return this.onResumed(frame);
      case "error":
        return this.onError(frame);
      default:
        return; // `subscribed`, `unsubscribed`, `pong` — the answer is the ack.
    }
  }

  private onWelcome(frame: Record<string, unknown>): void {
    this.welcomed = true;
    this.attempt = 0;
    this.credentialRetried = false;
    this.connection = {
      connectionId: String(frame.connectionId ?? ""),
      userId: typeof frame.userId === "string" ? frame.userId : null,
    };
    if (typeof frame.maxSubscriptions === "number") this.maxSubscriptions = frame.maxSubscriptions;
    if (typeof frame.heartbeatMs === "number") this.heartbeatMs = frame.heartbeatMs;

    this.startTimers();
    this.reestablish();
  }

  /**
   * Declare what we had, then re-prove what cannot be declared. The gateway
   * keeps nothing across a dropped socket, so every channel is authorized
   * again from scratch — and a proof-bearing one cannot ride in `resume`,
   * which carries no proofs.
   */
  private reestablish(): void {
    const declarable: string[] = [];
    const reprovable: Array<[string, string]> = [];
    for (const [channel, entry] of this.subscriptions) {
      if (entry.proof) reprovable.push([channel, entry.proof]);
      else declarable.push(channel);
    }

    for (let i = 0; i < declarable.length; i += RESUME_MAX_CHANNELS) {
      this.send({ type: "resume", channels: declarable.slice(i, i + RESUME_MAX_CHANNELS) });
    }
    for (const [channel, proof] of reprovable) {
      this.send({ type: "subscribe", channel, proof });
    }
  }

  private onMessage(frame: Record<string, unknown>): void {
    const channel = typeof frame.channel === "string" ? frame.channel : "";
    const entry = this.subscriptions.get(channel);
    if (!entry) return;
    for (const listener of [...entry.listeners]) listener.onMessage(frame.payload);
  }

  private onResumed(frame: Record<string, unknown>): void {
    const refused = Array.isArray(frame.refused) ? frame.refused : [];
    for (const name of refused) {
      const channel = String(name);
      const entry = this.subscriptions.get(channel);
      if (!entry) continue;
      if (entry.proof) {
        // Expected, not exceptional: this is how a proof-bearing channel
        // comes back after a reconnect.
        this.send({ type: "subscribe", channel, proof: entry.proof });
        continue;
      }
      this.failChannel(channel, "realtime.channelForbidden");
    }
  }

  private onError(frame: Record<string, unknown>): void {
    const code = String(frame.code ?? "") as RealtimeErrorCode;
    const channel = typeof frame.channel === "string" ? frame.channel : null;
    if (!channel) return; // A connection-wide refusal ends in a close.
    this.failChannel(channel, code);
  }

  private failChannel(channel: string, code: RealtimeErrorCode): void {
    const entry = this.subscriptions.get(channel);
    if (!entry) return;
    if (FATAL_FOR_CHANNEL.includes(code)) this.subscriptions.delete(channel);
    for (const listener of [...entry.listeners]) listener.onError?.(code);
  }

  private onClosed(code: number): void {
    this.clearTimers();
    const wasWelcomed = this.welcomed;
    this.socket = null;
    this.welcomed = false;
    this.connection = null;

    if (this.stopped) return;

    if (code === CLOSE_SESSION_GONE) {
      // The session marker is gone. Reconnecting with the same credential
      // asks the same question and gets the same answer, forever.
      this.stopped = true;
      this.options.onSessionLost?.();
      return;
    }

    if (!wasWelcomed && this.credentialOffered && !this.credentialRetried) {
      // The upgrade was refused before any socket existed. A browser cannot
      // see the 401, so a credential that has expired looks exactly like a
      // network drop — ask the page to refresh it, once, then retry.
      this.credentialRetried = true;
      this.options.onCredentialRejected?.();
    }

    if (code === CLOSE_TOO_MANY) {
      this.attempt = Math.max(this.attempt, BACKOFF_ATTEMPTS_AT_CAPACITY);
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoffMs();
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Exponential, capped, and jittered so a restarted gateway is not hit by
   * every panel in the same 50ms. */
  private backoffMs(): number {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  /**
   * The server's own heartbeat is a WebSocket ping, which a browser answers
   * without telling the page. So the page keeps its own: a `ping` frame on the
   * announced interval, and a socket that has heard nothing for two of them is
   * treated as gone. Without this a peer that vanished — a closed laptop, a
   * phone changing network — leaves this side holding an open socket that will
   * never carry anything again.
   */
  private startTimers(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.heartbeatMs);
    this.noteTraffic();
  }

  private noteTraffic(): void {
    if (!this.welcomed) return;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      const socket = this.socket;
      this.discard(socket);
      socket?.close(CLOSE_HEARTBEAT);
      this.onClosed(CLOSE_HEARTBEAT);
    }, this.heartbeatMs * 2);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.pingTimer = null;
    this.silenceTimer = null;
  }
}

/** The ordinary way to make one. */
export function createRealtimeClient(options: RealtimeClientOptions = {}): RealtimeClient {
  return new RealtimeClient(options);
}
