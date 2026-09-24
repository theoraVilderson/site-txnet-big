import {
  AUTOMATION_EXCHANGE_DEFAULT,
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
} from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * `metering-service` turns collection passes into usage and serves no requests
 * (ADR-0077).
 *
 * It needs four things, plus one courtesy, and holds nothing else: a broker to take passes from,
 * the application pool it writes every tenant's traffic through, the
 * cross-tenant pool that resolves a delta's config to its tenant, and how many
 * passes it works on at once. No JWT secret, no tenant credential, no vault
 * key — this process answers to nobody and only ever writes what a pass
 * measured. The courtesy is Redis, where the Grant's total goes for `/sub`
 * (F-609-a) — a write that is allowed to fail.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /**
   * **Not `DATABASE_URL`.** The rule since F-066-m-a: `DATABASE_URL` owns every
   * table and Row-Level Security is inert against it. `traffic_raw_log` carries
   * a policy since F-027-ak and `grant` since it had a `tenantId`; this pool is
   * what those policies are written for, and the tenant is bound per delta by
   * `tenantTransaction`. There is no fallback.
   */
  DATABASE_APP_URL: z.string().min(1, 'DATABASE_APP_URL is required'),

  /**
   * The second pool, held by one reader (`MeteringService.configsOf`).
   *
   * Required rather than optional, unlike a job's dependency elsewhere: a pass
   * over a platform-owned panel carries no tenant, so without this read every
   * byte on such a panel would be written down as unattributed. A degraded mode
   * that silently misfiles usage is worse than a process that will not boot.
   */
  DATABASE_CROSS_TENANT_URL: z.string().min(1, 'DATABASE_CROSS_TENANT_URL is required'),

  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
  /** The exchange every automation message rides; the default is shared-core's (F-079). */
  AUTOMATION_EXCHANGE: z.string().min(1).default(AUTOMATION_EXCHANGE_DEFAULT),
  /** Where a rejected pass goes (F-067-d) — the same dead-letter exchange the rest of the platform uses. */
  AUTOMATION_DLX: z.string().min(1).default('txnet.automation.dlx'),
  /** This service's own queue, bound to `network.usage.#`. */
  METERING_QUEUE: z.string().min(1).default('txnet.network.usage'),
  /**
   * How many passes one replica holds unacked.
   *
   * Low on purpose: one pass is up to 500 deltas and each delta is its own
   * transaction, so the work behind a single message is already substantial and
   * a deep prefetch only moves the queue's depth into a process that can lose
   * it on a restart.
   */
  METERING_PREFETCH: z.coerce.number().int().positive().default(2),

  /** Where `sub:usage:<grantId>` is written (F-609-a), under the platform's one keyspace prefix (ADR-0005). */
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_KEY_NAMESPACE: z.string().min(1).default(REDIS_KEY_NAMESPACE_DEFAULT),
  REDIS_KEYSPACE_VERSION: z.string().min(1).default(REDIS_KEYSPACE_VERSION_DEFAULT),
  /**
   * How long a Grant's published total outlives its last delta.
   *
   * **Keep it at or above `sub-service`'s `SUB_RENDER_TTL`** (1h). `/sub`
   * falls back to the figure a render was built with when the key is gone;
   * that fallback is only as fresh as this key if the key cannot expire before
   * every render built ahead of the Grant's last delta has.
   */
  SUB_USAGE_TTL_SECONDS: z.coerce.number().int().min(3600).default(86_400),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Environment validation failed — see log above');
  }
  return parsed.data;
}

/**
 * `skipProcessEnv` for the reason `bot-service` documents: compose passes every
 * optional variable as `VAR=${VAR:-}`, so an unset option arrives as the empty
 * string and `ConfigService.get` would read that raw `''` over the schema's
 * default.
 */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
