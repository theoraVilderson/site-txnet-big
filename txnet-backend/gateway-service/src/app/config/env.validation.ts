import {
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  normalizeRedisNamespace,
} from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * `gateway-service` holds WebSocket connections and nothing else (F-067-h).
 *
 * It is deliberately the thinnest deployable on the platform. It has no
 * database, no JWT secret and no tenant credential: identity arrives as
 * headers `forward-auth` set and Traefik forwarded, which is the same rule
 * `bot-service` follows (ADR-0009) and the reason a socket needs no second
 * identity model. Its one dependency is the Redis that says whether a session
 * is still live.
 *
 * Every limit below is a per-connection or per-user ceiling. They are
 * configuration rather than constants because the right numbers depend on how
 * many replicas a deployment runs and how much memory each has, and because a
 * connection cap that cannot be lowered during an incident is not a control.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * The shared store holding `session:<id>`. **Required**, and it is the only
   * required dependency: a gateway that cannot ask whether a session is live
   * can only hold connections open past a revocation, which is the one thing
   * this process must never do quietly.
   */
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  /** Must equal what `auth-service` and `auth-handler` use (ADR-0005). */
  REDIS_KEY_NAMESPACE: z.string().min(1).default(REDIS_KEY_NAMESPACE_DEFAULT),
  REDIS_KEYSPACE_VERSION: z
    .string()
    .min(1)
    .default(REDIS_KEYSPACE_VERSION_DEFAULT),

  /**
   * The path the upgrade arrives on. It must agree with the Traefik router
   * rule that carries `my-auth-optional`; a socket reachable on a path the
   * gate does not cover has had no decision made about it at all, and this
   * process refuses one (`identity.ts`) rather than trusting the router to be
   * right. That is what the gate's anonymous marker is for — "nobody is signed
   * in" is an answer, and "no answer" is not.
   */
  REALTIME_PATH: z.string().min(1).default('/realtime'),

  /**
   * How often every connection is pinged. A peer that vanished — a closed
   * laptop, a phone changing network — leaves a TCP connection that stays open
   * on this side for ever, holding a socket and a slot in the per-user cap;
   * the heartbeat is the only thing that ever notices. A connection that
   * misses one ping is closed, so this is also the worst-case time a dead
   * connection is carried.
   *
   * Thirty seconds is comfortably under the idle timeout of every proxy in
   * this path (Traefik's default is 60s), which matters: a keepalive slower
   * than the intermediary it is meant to keep alive achieves nothing.
   */
  REALTIME_HEARTBEAT_MS: z.coerce.number().int().positive().default(30_000),

  /**
   * How often the gateway re-asks whether each held session is still live.
   *
   * This is the window a revoked session keeps its socket, so it is a security
   * number, not a tuning one. It is a single `EXISTS` per *distinct session*
   * per tick — not per connection — so the cost is bounded by how many people
   * are connected rather than by how many tabs they have open. A minute is
   * short against the 30-day session lifetime and long against the cost.
   */
  REALTIME_SESSION_RECHECK_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),

  /**
   * How many channels one connection may hold. The cap F-067-h asks to be
   * built from the first line, because it cannot be added later without
   * breaking clients that grew past it: without one a single client subscribes
   * to every channel it can name and the per-channel index becomes a
   * client-controlled allocation.
   */
  REALTIME_MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().default(32),

  /**
   * How many sockets one **user** may hold on one replica. A person with
   * several tabs is normal; a reconnect loop is not, and this is what stops
   * the second from being free. Checked before the handshake, so a looping
   * client is refused with a 429 rather than upgraded and then closed.
   */
  REALTIME_MAX_CONNECTIONS_PER_USER: z.coerce
    .number()
    .int()
    .positive()
    .default(4),

  /**
   * How many **anonymous** sockets one client address may hold on one replica
   * (ADR-0031).
   *
   * The per-user cap above cannot apply to a connection with no user, and
   * without a replacement the anonymous upgrade would be the one unbounded
   * entry point on the platform. An address is a worse key than a user — it
   * lumps everyone behind one NAT together and it moves when a phone changes
   * network — so the default is generous. It is a ceiling on abuse, not a
   * quota anybody should reach: an anonymous socket is opened by a page that
   * has not signed in yet, and one page opens one.
   */
  REALTIME_MAX_CONNECTIONS_PER_IP: z.coerce
    .number()
    .int()
    .positive()
    .default(16),

  /**
   * The largest frame accepted from a client. Frames inbound to this gateway
   * are `subscribe` / `unsubscribe` / `resume` / `ping` and nothing else, so
   * the ceiling is generous at 8 KiB. `ws` closes a connection that exceeds it
   * before the payload is buffered, which is the point — the alternative is
   * that a client chooses how much memory this process allocates.
   */
  REALTIME_MAX_FRAME_BYTES: z.coerce.number().int().positive().default(8_192),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(
      '❌ Invalid environment variables:',
      parsed.error.flatten().fieldErrors,
    );
    throw new Error('Environment validation failed — see log above');
  }
  return parsed.data;
}

/**
 * `skipProcessEnv` for the reason `bot-service` and `worker-service` document:
 * compose passes every optional variable as `VAR=${VAR:-}`, so an unset option
 * arrives as the empty string and `ConfigService.get` would read that raw `''`
 * in preference to the schema's default.
 */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
