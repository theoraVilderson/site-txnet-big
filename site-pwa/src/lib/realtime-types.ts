// The realtime client's public shapes, apart from the client itself (`realtime.ts` re-exports them).

/** Refusal codes a subscriber can be told about. Machine keys, never text. */
export type RealtimeErrorCode =
  | "realtime.channelUnknown"
  | "realtime.channelForbidden"
  | "realtime.subscriptionLimit"
  | "realtime.badFrame";

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
  /**
   * The channel is back after a dropped socket, and anything published while
   * it was down went to nobody — nothing is queued for a closed socket. A
   * listener that shows a record re-reads it here. Called once the server has
   * accepted the channel again, and never on the first connection.
   */
  onMissed?: () => void;
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
   * Asked first on a `4401`, with the credential that socket carried: a token
   * rotation (an access change, AC-1-r) retires the old session too. A *different*
   * live credential back means this tab already holds the session that replaced
   * it — reconnect with it; anything else is a real sign-out.
   */
  recoverSession?: (dead: string | null) => Promise<string | null>;
  /**
   * The gateway closed with `4403`: this tenant is terminated (F-018-ac). The
   * client has stopped for good — a reconnect is refused `403` — and the page
   * says the service is closed. Not a sign-out: the session may still be live.
   */
  onTenantClosed?: () => void;
  /**
   * The socket closed before it was welcomed while a credential was offered.
   * A browser cannot see the `401` the gate answered — it sees a close with no
   * status — so this is the one hook that can refresh the token and let the
   * next attempt carry a live one. Called at most once per connect cycle.
   */
  onCredentialRejected?: () => void;
  socketFactory?: SocketFactory;
};
