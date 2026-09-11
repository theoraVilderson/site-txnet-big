/**
 * The wire between a process that computed a result and the gateway replica
 * holding the user's socket (F-067-i).
 *
 * **Why this file is shared rather than copied.** The producer is
 * `worker-service` and the consumer is `gateway-service` — two Nx
 * applications that never import each other, so the only thing joining them is
 * the name on the wire and the shape of the body. `botUpdateQueueName` exists
 * for the same reason (F-067-b): an address agreed by two processes is a
 * contract, and a contract kept as two hand-copied constants drifts on the
 * first edit that only remembers one of them.
 *
 * **Why Redis pub/sub and not the broker.** Every other message in this
 * platform rides RabbitMQ, and this one deliberately does not. A realtime
 * event is at-most-once by contract — an event published while nobody is
 * connected is dropped, and the durable answer, where one exists, belongs to
 * the producer (`realtime/contract.md`, D-15). RabbitMQ would give it exactly
 * the properties it must not have: a durable queue per replica to declare and
 * tear down as replicas come and go, and a dead-letter path (F-067-d) that
 * would preserve messages the contract says to drop. Redis pub/sub has the
 * semantics this needs and both processes already hold a client on the same
 * Redis, so it costs one connection rather than a topology.
 *
 * **Fan-out is per channel, not per replica.** The producer publishes to
 * `realtime:<channel>` and a gateway replica subscribes to exactly the
 * channels its own connections hold, so Redis routes each event to the
 * replica — or replicas — that can use it and to no others. The alternative,
 * one broadcast channel every replica filters, sends every event to every
 * replica: it works, and it costs N times the traffic to deliver the same
 * message, which is the shape that only becomes a problem at the scale this
 * row exists for.
 */

/**
 * The name space realtime fan-out occupies inside the shared keyspace. The
 * full wire name is `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:` +
 * this + the realtime channel — for example
 * `txnet:auth:v2:realtime:user:<userId>`.
 *
 * **The keyspace prefix must be applied by hand on both sides.** ioredis
 * prepends `keyPrefix` to *key* arguments only, and `PUBLISH` / `SUBSCRIBE`
 * take a channel, which Redis does not count as a key — so the prefix every
 * other call gets for free is silently absent here. Publishing prefixed and
 * subscribing unprefixed produces no error and no delivery, which is why the
 * two ends are built from one function and covered by a spec.
 */
export const REALTIME_FANOUT_PREFIX = 'realtime:';

/**
 * One fan-out event.
 *
 * `payload` is opaque on purpose: it is whatever the producing domain decided
 * is worth sending, and it reaches the client verbatim inside the `message`
 * frame. This layer moves it; it does not read it.
 */
export interface RealtimeFanoutMessage {
  payload: unknown;
}

/** The body a producer publishes. */
export function encodeRealtimeFanout(payload: unknown): string {
  return JSON.stringify({ payload } satisfies RealtimeFanoutMessage);
}

/**
 * The body a gateway replica received, or `null` when it is not one.
 *
 * A subscriber is reading a shared Redis that anything on the platform can
 * publish to, so a body that does not parse is dropped with a log line rather
 * than thrown on: an exception inside a pub/sub listener has no caller to
 * catch it and would take the process — and every socket on it — down.
 *
 * `null` for anything that is not an object carrying a `payload` key,
 * including a bare value that happens to be valid JSON. A producer that
 * published the payload raw instead of enveloped is a mistake this must not
 * paper over, because papering over it means the field can never be joined by
 * a second one.
 */
export function decodeRealtimeFanout(raw: string): RealtimeFanoutMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return null;
  }
  if (!('payload' in json)) return null;
  return { payload: (json as RealtimeFanoutMessage).payload };
}

/**
 * The realtime channel one OTP delivery result rides (F-067-j).
 *
 * Built here because three processes have to agree on it and none of them
 * import each other: `auth-service` hands the name to the client in the 202,
 * `worker-service` publishes to it, and `gateway-service` authorizes a
 * subscription to it. The gateway matches the `otp` family with its own
 * literal — that file is the security surface and reads better stating its
 * families outright — but the *name* a producer builds comes from here.
 *
 * `channelId` is not the delivery id. They are minted together and they are
 * both 16 random bytes, but they address different things and only one of them
 * is a name this platform writes down: a channel name reaches Redis pub/sub,
 * gateway logs and metrics, while the delivery id is the capability that reads
 * the status. Reusing one value for both would put the capability in every one
 * of those places for nothing.
 */
export function otpRealtimeChannel(channelId: string): string {
  return `${RealtimeChannelFamily.otp}:${channelId}`;
}

/**
 * The three realtime channel families, declared once (ADR-0036, C-04).
 *
 * A channel name crosses two process boundaries: `worker-service` and
 * `auth-service` publish into one, `gateway-service` parses it to decide who
 * may subscribe, and the browser asks for one by name. The family is the part
 * every side has to agree on, and it was a bare literal on each — a `case`
 * label in the gateway's authorization switch, a template literal in the
 * builder above.
 *
 * That is worse than the usual duplication because of which way it fails. The
 * gateway's switch has a default that refuses, so a family the publisher
 * renamed and the gateway did not simply stops authorizing: every subscription
 * is refused as unknown, the page shows nothing, and no error is logged
 * anywhere that says the two disagreed about a name.
 */
export const RealtimeChannelFamily = {
  /** One person. Needs no permission beyond being that person. */
  user: 'user',
  /** The reseller-wide feed, behind a permission. */
  tenant: 'tenant',
  /** One OTP send's delivery result, authorized by a minted token. */
  otp: 'otp',
} as const;

export type RealtimeChannelFamily =
  (typeof RealtimeChannelFamily)[keyof typeof RealtimeChannelFamily];

/** The channel one person's events ride. */
export function userRealtimeChannel(userId: string): string {
  return `${RealtimeChannelFamily.user}:${userId}`;
}

/** The channel one tenant's events ride. */
export function tenantRealtimeChannel(tenantId: string): string {
  return `${RealtimeChannelFamily.tenant}:${tenantId}`;
}

/**
 * What arrives on that channel: the end state of one OTP send, and never the
 * code.
 *
 * `identity/invariants.md` #2 keeps the plaintext code inside the process that
 * sends it, and a realtime event is about the least private place on the
 * platform — an at-most-once message on a channel whose only credential is a
 * token that was handed to whoever asked. `state` is the same vocabulary the
 * status route answers with, so a client that missed the event and polls
 * instead reads the identical two fields.
 */
export interface OtpDeliveryEvent {
  state: 'sent' | 'failed';
  /** An i18n key, on `failed` only. */
  failureKey?: string;
}
