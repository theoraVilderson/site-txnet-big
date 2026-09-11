import {
  AUTOMATION_EXCHANGE_DEFAULT,
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  normalizeRedisNamespace,
} from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * `worker-service` runs background work and serves no requests (ADR-0027).
 *
 * The substrate needs four things: a broker to take ticks from, a database to
 * read `bot_worker` / `bot_schedule` and to append `bot_execution_log` to, a
 * Redis holding the per-tenant run leases, and a timer interval. The Redis is
 * F-067-e's doing and is the one that had to be argued for — see
 * `REDIS_URL` below.
 *
 * A **job** may need a fourth, and F-031-c is where the first one did. It still
 * holds no JWT secret and no tenant credential — it holds the service token
 * that opens the internal seam, and asks the process that owns a credential to
 * act on it. Every such variable below is optional for the reason stated on it:
 * this process must boot whether or not any one job's dependency is configured.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /**
   * **Not `DATABASE_URL`.** The same rule `auth-service` follows since
   * F-066-m-a: `DATABASE_URL` is the superuser that owns every table, and
   * Row-Level Security is not enforced against it. There is no fallback, for
   * the same reason there is none there — a fallback is a silent return to no
   * isolation at all.
   *
   * `automation`'s three worker tables carry no `tenantId` and no policy, so
   * this pool reads them under no scope. That is not an exception being taken:
   * the grants in `20260909000500_row_level_security` cover every schema, and
   * a table with no policy is simply readable by a role that was granted it.
   */
  DATABASE_APP_URL: z.string().min(1, 'DATABASE_APP_URL is required'),

  /**
   * The shared store behind the per-tenant concurrency cap (F-067-e, D-17).
   *
   * **Required, unlike every optional variable below.** A job's dependency may
   * be missing and cost that job its own runs; this one is the substrate — a
   * process that cannot reach it caps each tenant in its own memory, which is
   * F-066-p's limit and the thing this row exists to remove. Booting without
   * it would make the degraded mode the normal one, silently.
   *
   * `TenantConcurrencyGate` still survives a Redis that goes away *later*: it
   * falls back to counting locally rather than refusing every tenant tick.
   * That is a degradation, not a configuration.
   */
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  /**
   * The same namespace and version `auth-service` and `bot-service` use: one
   * `REDIS_KEYSPACE_VERSION` bump must abandon every key this platform holds,
   * run leases included (ADR-0005). A lease orphaned by a bump expires on its
   * own deadline, so the cost of a bump here is bounded by
   * `AUTOMATION_RUN_TIMEOUT_MS`.
   */
  REDIS_KEY_NAMESPACE: z.string().min(1).default(REDIS_KEY_NAMESPACE_DEFAULT),
  REDIS_KEYSPACE_VERSION: z
    .string()
    .min(1)
    .default(REDIS_KEYSPACE_VERSION_DEFAULT),

  /** `amqp://user:pass@host:5672`. The broker in `dev-docker`. */
  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
  /**
   * The topic exchange every `automation.tick.<key>` is published to. Durable,
   * because a tick published while no worker is up must survive the broker
   * restarting — the queue behind it is durable for the same reason.
   */
  AUTOMATION_EXCHANGE: z
    .string()
    .min(1)
    .default(AUTOMATION_EXCHANGE_DEFAULT),
  /**
   * The queue this process consumes ticks from.
   *
   * **`.v2` because a queue's arguments cannot be changed in place.** F-067-d
   * declares this queue with `x-dead-letter-exchange`, and asserting an
   * existing durable queue with different arguments fails with
   * PRECONDITION_FAILED — a boot failure on every deployment that already ran
   * the previous build. A new name makes the change self-healing: the old
   * `txnet.automation.ticks` holds at most one tick interval of work, every
   * tick recurs, and the empty queue can be deleted whenever an operator gets
   * to it.
   */
  AUTOMATION_QUEUE: z.string().min(1).default('txnet.automation.ticks.v2'),
  /**
   * Where a message goes when it is rejected (F-067-d). The queue above names
   * this exchange in its `x-dead-letter-exchange` argument, so a failed
   * handler, a body that is not JSON and a tick the tenant gate gave up on all
   * land here instead of being destroyed by the broker.
   */
  AUTOMATION_DLX: z.string().min(1).default('txnet.automation.dlx'),
  /**
   * The queue bound to that exchange, drained into `automation.dead_letter` by
   * `DeadLetterDrain`. It is a transport, not the record: a queue is read by
   * consuming it, so whoever looks last decides what nobody else ever sees.
   */
  AUTOMATION_DEAD_QUEUE: z
    .string()
    .min(1)
    .default('txnet.automation.ticks.dead'),
  /**
   * The OTP delivery queue (F-067-a), bound to `otp.delivery.#` on the same
   * exchange and dead-lettering to the same DLX. Separate from the tick queue
   * so a slow SMS provider cannot sit in front of a scheduled job, and so the
   * two depths can be alerted on separately (F-067-g).
   */
  AUTOMATION_OTP_QUEUE: z.string().min(1).default('txnet.automation.otp'),
  /**
   * The bot-update queue set (F-067-b): `<prefix>.0` … `<prefix>.N-1`, each
   * bound to its own `bot.update.<slot>` on the same exchange and
   * dead-lettering to the same DLX.
   */
  BOT_UPDATE_QUEUE_PREFIX: z
    .string()
    .min(1)
    .default('txnet.automation.bot.update'),
  /**
   * How many queues that set has — **it must match `bot-service`'s
   * `BOT_UPDATE_QUEUES`**. That side hashes a chat id into a routing key and
   * this side declares the queues bound to those keys, so a mismatch is either
   * an update addressed to a queue nobody declared (loud: the publish is
   * `mandatory`, so it is returned and the webhook answers 5xx) or a queue
   * nobody publishes to (silent, and only visible as an idle consumer).
   *
   * Each queue is consumed by exactly one consumer holding one message at a
   * time, so this number is the bot's whole cross-chat parallelism — and
   * within one chat it changes nothing, which is the point (D-16).
   */
  BOT_UPDATE_QUEUES: z.coerce.number().int().positive().default(4),
  /**
   * How many ticks this process will run at once, across every tenant. The
   * per-tenant half of the same knob is `AUTOMATION_TENANT_CONCURRENCY` below.
   */
  AUTOMATION_PREFETCH: z.coerce.number().int().positive().default(4),
  /**
   * How many of those slots **one tenant** may hold at once (F-066-p, catalog
   * 20.2 layer 4). `AUTOMATION_PREFETCH` bounds the process in total, which is
   * not isolation: one tenant with a thousand due occurrences takes every slot
   * and every other tenant's schedule stops firing.
   *
   * Keep it below `AUTOMATION_PREFETCH` — at or above it the cap can never bind
   * and the setting is decoration. The default is half, which leaves room for
   * at least one other tenant however busy the first one is.
   *
   * Since F-067-e the cap is **shared**, not per process: the count is a set
   * of expiring leases in Redis, so this number means the same thing whatever
   * the replica count. `AUTOMATION_PREFETCH` stays per process — it is a
   * throughput knob, and the two are only comparable within one replica.
   */
  AUTOMATION_TENANT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /**
   * How long a tick refused by that cap waits before it is put back on the
   * exchange. It is a yield, not a retry budget: the refused tick returns to
   * the *back* of the queue, so every other tenant's work is served first.
   *
   * Too short and a saturated tenant churns the broker; too long and its own
   * work is delayed past the point the delay was meant to smooth. Five seconds
   * is short against the tick interval and long against a broker round trip.
   */
  AUTOMATION_DEFER_MS: z.coerce.number().int().positive().default(5_000),

  /**
   * How many unpublished `automation.outbox_event` rows one relay run claims
   * (F-067-c, ADR-0021).
   *
   * The batch is held under `FOR UPDATE SKIP LOCKED` for as long as it takes
   * to publish every row in it, so this is a lock-duration knob as much as a
   * throughput one: too large and one relay holds rows a second replica could
   * have taken, too small and the relay cannot keep up with a burst inside one
   * `AUTOMATION_TICK_INTERVAL_MS`. A hundred confirmed publishes is a fraction
   * of a second against a healthy broker.
   */
  AUTOMATION_OUTBOX_BATCH: z.coerce.number().int().positive().default(100),

  /**
   * How long a publish waits for the broker to confirm it before it is treated
   * as lost (F-067-f). It bounds the caller, not the broker: without it a
   * broker that has stopped answering holds a publisher for ever, which is a
   * slower version of the silent loss confirms exist to prevent.
   *
   * Five seconds is long against a healthy round trip — confirms are answered
   * in milliseconds — and short against `AUTOMATION_TICK_INTERVAL_MS`, so a
   * timed-out tick is reported well before the next one is published.
   */
  AUTOMATION_PUBLISH_CONFIRM_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),

  /**
   * How often the publisher asks the database which workers are due. It is not
   * the resolution of a schedule: `workerIsDue` is asked about the interval
   * since the last tick, so an occurrence that fell between two ticks — or
   * during a restart — is still found. Shortening this makes a job start
   * sooner; it does not make a job run more often.
   */
  AUTOMATION_TICK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),

  /**
   * A job that has been running this long is assumed dead and its run log is
   * closed as `failed`. Without it a process killed mid-run leaves a
   * `bot_execution_log` row with a `startedAt` and no `finishedAt` for ever,
   * and invariant #3's "runs are never silent" degrades into "runs are never
   * finished".
   *
   * Since F-067-e it is also the lifetime of a tenant run lease, deliberately
   * the same number: the slot a dead process was holding and the run row it
   * left open stop being real at the same moment. Shorten this and a live run
   * can have its slot given to someone else; lengthen it and a killed replica
   * holds a tenant's budget for longer.
   */
  AUTOMATION_RUN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60_000),

  /**
   * The internal seam a job reaches another service's code through, and the
   * credential that opens it (ADR-0011, `ServiceOnlyGuard`). `VaultRetentionJob`
   * is the first job to need one: the Credential Vault is `tenant`'s code
   * inside `auth-service`, and an Nx app cannot import an Nx app (F-031-c).
   *
   * **Optional, and that is the decision.** This process holds no credential of
   * its own (see the note above), so it must boot without one — a job whose
   * seam is unconfigured fails its own run, loudly, into `bot_execution_log`,
   * and every other job keeps running. Requiring them here would mean the
   * broker consumer stops draining the queue because one job's dependency is
   * missing.
   */
  AUTH_API_BASE_URL: optional(z.string()),
  SERVICE_AUTH_TOKEN: optional(z.string()),
  /**
   * How long a job waits on that seam. It matters more here than in a request
   * handler: a hung connection holds one of `AUTOMATION_PREFETCH` slots and
   * leaves an open `bot_execution_log` row until `AUTOMATION_RUN_TIMEOUT_MS`
   * closes it as `failed`, which is the slow, quiet version of a stuck worker.
   */
  AUTH_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /**
   * The other end of the same seam: `bot-service`, which owns the conversation
   * a queued update runs (F-067-b, `BotUpdateConsumer`). Optional for the
   * reason the pair above is — this process boots with no credential and no
   * seam configured, and a consumer whose seam is missing fails its own
   * messages into the dead-letter table rather than stopping the broker.
   */
  BOT_API_BASE_URL: optional(z.string()),
  /**
   * How long a queued update may take to run before it is abandoned. Longer
   * than `AUTH_API_TIMEOUT_MS` would be wrong and much shorter would be too:
   * one bot flow is itself one or more `auth-api` round trips made *inside*
   * `bot-service`, plus a `sendMessage` to the platform.
   */
  BOT_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /** Optional label in every log line, for a deployment running several. */
  WORKER_NAME: optional(z.string()),
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
 * `skipProcessEnv` for the reason `bot-service` documents at length: compose
 * passes every optional variable as `VAR=${VAR:-}`, so an unset option arrives
 * as the empty string, and `ConfigService.get` would read that raw `''` in
 * preference to the schema's default.
 */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
