import { z } from 'zod';

/**
 * The frames on the wire (F-067-h).
 *
 * Everything a client sends is parsed here and nowhere else, with zod, the
 * same way `auth-service` parses a request body (`*.schema.ts`). A socket is
 * an unvalidated input for its whole lifetime rather than for one request, so
 * the parse is not a formality: after the upgrade there is no guard, no pipe
 * and no controller between the network and this process.
 */

/** The subprotocol carrying the access token, and the one this server selects. */
export const REALTIME_SUBPROTOCOL = 'txnet.v1';

export const clientFrameSchema = z.discriminatedUnion('type', [
  /**
   * `proof` is the claim a channel needs when no identity covers it — today
   * the token minted with an OTP delivery (F-067-j). Optional because the two
   * original families are authorized by who the connection is, and a client
   * subscribing to its own `user:` channel has nothing to present.
   */
  z.object({
    type: z.literal('subscribe'),
    channel: z.string().min(1).max(200),
    proof: z.string().min(1).max(200).optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), channel: z.string().min(1).max(200) }),
  /**
   * Reconnect (F-067-h asks for "reconnect with resume").
   *
   * The client declares the channels it believes it had and every one is
   * authorized again from scratch — the gateway keeps nothing across a dropped
   * socket. That is a deliberate choice, not a shortcut: a resume token
   * redeemed against server-side state would only work when the reconnect
   * happens to land on the replica that holds it, which is the failure F-067-i
   * describes — it works in dev with one replica and silently stops working
   * the day there are two. Declaring the set costs one round trip, works on
   * any replica, and cannot go stale.
   *
   * Re-authorizing is the load-bearing half: a reconnect presents a new token,
   * and the identity behind it may have changed.
   *
   * **A proof-bearing channel cannot be resumed**, because this frame carries
   * no proofs and inventing a place to keep them would be the server-side
   * resume state the paragraph above rejects. Such a channel comes back in the
   * refused list and the client re-subscribes to it explicitly, which it can
   * do: it is holding the proof already.
   */
  z.object({
    type: z.literal('resume'),
    channels: z.array(z.string().min(1).max(200)).max(64),
  }),
  /** An application-level ping, for a client that cannot see WebSocket pongs. */
  z.object({ type: z.literal('ping') }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

export type ServerFrame =
  /** Sent once, immediately after the upgrade. Carries the limits. */
  | {
      type: 'welcome';
      connectionId: string;
      /**
       * `null` on an anonymous connection (ADR-0031). It is the field a client
       * reads to know which half of the platform it is talking to, so it is
       * present-and-null rather than absent — a missing key reads as an older
       * server, and a null reads as "the gate identified nobody".
       */
      userId: string | null;
      heartbeatMs: number;
      maxSubscriptions: number;
    }
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  /** The answer to a `resume`: what was restored and what was refused. */
  | { type: 'resumed'; channels: string[]; refused: string[] }
  | { type: 'pong' }
  /**
   * A refusal. `code` is a machine key the page maps to its own text — it is
   * deliberately **not** translated, unlike the `msg` of an HTTP envelope
   * (`forward-auth/contract.md`). A frame is read by code and never shown to a
   * person as-is, and putting `locale-service` in the path of a socket error
   * would make a refusal depend on a service the socket does not otherwise
   * need.
   */
  | { type: 'error'; code: RefusalCode; channel?: string }
  /**
   * An event on a subscribed channel, fanned out from the process that
   * computed it (`contract.fanout.md`). The first producer is the OTP delivery
   * result (F-067-j).
   */
  | { type: 'message'; channel: string; payload: unknown };

export type RefusalCode =
  | 'realtime.channelUnknown'
  | 'realtime.channelForbidden'
  /** The per-connection subscription cap is full. */
  | 'realtime.subscriptionLimit'
  /** Not JSON, too large, or not a frame this version defines. */
  | 'realtime.badFrame';

/**
 * The close codes this server uses. 4000+ is the range reserved for the
 * application, and each of these means something the client should act on
 * differently: re-authenticate, back off, or stop.
 */
export const CloseCode = {
  /** The session behind this connection is gone — sign in again. */
  SessionRevoked: 4401,
  /** The heartbeat went unanswered. Reconnect. */
  HeartbeatTimeout: 4408,
  /** Too many sockets for one user. Do not immediately retry. */
  TooManyConnections: 4429,
  /** The server is shutting down. Reconnect after a backoff. */
  GoingAway: 4503,
} as const;

/**
 * The outcome of parsing one inbound message: exactly one of the two fields
 * is set. Two nullable fields rather than a discriminated union for the reason
 * `channel.ts` gives — this workspace compiles without `strictNullChecks`, so
 * a union would not narrow at the call site.
 */
export interface ParsedFrame {
  frame: ClientFrame | null;
  code: RefusalCode | null;
}

/**
 * Parse one inbound message. A frame that does not parse is a refusal, never
 * an exception: a client can send anything, and a throw here would take the
 * connection — or the process — with it.
 */
export function parseClientFrame(raw: string): ParsedFrame {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { frame: null, code: 'realtime.badFrame' };
  }
  const parsed = clientFrameSchema.safeParse(json);
  return parsed.success
    ? { frame: parsed.data, code: null }
    : { frame: null, code: 'realtime.badFrame' };
}
