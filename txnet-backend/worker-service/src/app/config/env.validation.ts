import { z } from 'zod';

/**
 * `worker-service` runs background work and serves no requests (ADR-0027).
 *
 * The substrate needs three things and no more: a broker to take ticks from,
 * a database to read `bot_worker` / `bot_schedule` and to append
 * `bot_execution_log` to, and a timer interval.
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

  /** `amqp://user:pass@host:5672`. The broker in `dev-docker`. */
  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
  /**
   * The topic exchange every `automation.tick.<key>` is published to. Durable,
   * because a tick published while no worker is up must survive the broker
   * restarting — the queue behind it is durable for the same reason.
   */
  AUTOMATION_EXCHANGE: z.string().min(1).default('txnet.automation'),
  /** The queue this process consumes ticks from. */
  AUTOMATION_QUEUE: z.string().min(1).default('txnet.automation.ticks'),
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
   * The cap is per process, the grain `AUTOMATION_PREFETCH` already has: N
   * replicas give a tenant N budgets. `tenant-concurrency.gate.ts` says why
   * that is stated rather than solved.
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
