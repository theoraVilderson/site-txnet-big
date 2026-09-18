import {
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
} from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * A per-route request limit: a positive whole number with a default, and `''`
 * (compose's `VAR=${VAR:-}`) read as unset — `auth-service`'s rule (F-087).
 */
const rateLimit = (fallback: number) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(fallback),
  );

/**
 * `tenant-service`'s environment, validated at boot (F-089, ADR-0036).
 *
 * `notification-service`'s schema with every delivery line left out: tenant
 * administration sends nothing (ADR-0058). Each variable says why it is
 * required or why an empty value is safe. Per-route rate limits arrive with the
 * routes that use them (the first with F-019-h), named `<ROUTE>_RATE_LIMIT`.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  GLOBAL_PREFIX: z.string().min(1).default('api'),
  /** The host this service reports itself reachable at, for the boot log only. */
  PUBLIC_HOST: z.string().min(1).default('localhost'),

  /**
   * The app role (`NOBYPASSRLS`), never the owner — the reason
   * `billing-service` gives. Required, with no fallback to `DATABASE_URL`.
   */
  DATABASE_APP_URL: z.string().min(1, 'DATABASE_APP_URL is required'),

  /**
   * The cross-tenant role: the platform owner administers every reseller, and
   * no single tenant binding can read them (ADR-0053's pool, as
   * `notification-service` holds it). Required.
   */
  DATABASE_CROSS_TENANT_URL: z.string().min(1, 'DATABASE_CROSS_TENANT_URL is required'),

  /**
   * The platform's base domain: a new reseller's host is `<slug>.$DOMAIN_NAME`
   * (F-018-y). Required — an empty one would issue a host nobody can reach.
   */
  DOMAIN_NAME: z.string().min(1, 'DOMAIN_NAME is required'),

  /**
   * Custom-domain proof (F-018-i, catalog 13.2): how long a `verifying` domain
   * is retried before it is `failed`; how often a `verified` one's TXT record
   * is re-checked; how long a missing record keeps routing before the domain
   * drops to `pending`; and the ceiling on one http/https probe.
   */
  DOMAIN_VERIFY_WINDOW_HOURS: z.coerce.number().positive().default(72),
  DOMAIN_REVALIDATE_EVERY_HOURS: z.coerce.number().positive().default(6),
  DOMAIN_REVALIDATION_GRACE_HOURS: z.coerce.number().positive().default(72),
  DOMAIN_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * Object storage (F-018-m, `platform/object-storage`): which driver holds the
   * bytes, and for `local` the mounted volume. Only `local` is built; an
   * S3-compatible driver arrives behind the same port. **One node, or a volume
   * every replica shares** — replicas on separate disks each hold a different
   * subset of the files.
   */
  OBJECT_STORAGE_DRIVER: z.enum(['local']).default('local'),
  OBJECT_STORAGE_LOCAL_ROOT: z.string().min(1).default('/data/objects'),

  /** The panel's origin, for CORS with credentials; required in production (`main.ts`). */
  FRONTEND_ORIGIN: z.string().default(''),

  /**
   * The platform's own processes, proving themselves to `internal/*`
   * (`ServiceOnlyGuard`, ADR-0011) — `worker-service`'s renewal, once F-018-v
   * moves it here. Empty closes the seam, so it is required in production.
   */
  SERVICE_AUTH_TOKEN: z.string().default(''),

  /**
   * The Credential Vault's KEK (ADR-0026) — a **path to a mounted secret**,
   * never the key: a value here would be visible in `docker inspect`. The
   * vault's internal seams live here since F-018-ab; unset boots the service
   * and refuses every vault operation, as in every other loader.
   */
  VAULT_KEK_FILE: z.string().min(1).optional(),

  /** The envelope's translator (`locale/locale.service.ts`). */
  LOCALE_SERVICE_ADDR: z.string().min(1).default('localhost:50051'),
  LOCALE_SCOPE: z.string().min(1).default('backend'),
  DEFAULT_LANGUAGE: z.string().min(1).default('fa'),

  /** The rate limiter's counters and `TenantStatusGuard`'s status key: required. */
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_KEY_NAMESPACE: z.string().min(1).default(REDIS_KEY_NAMESPACE_DEFAULT),
  REDIS_KEYSPACE_VERSION: z
    .string()
    .min(1)
    .default(REDIS_KEYSPACE_VERSION_DEFAULT),

  /** The platform-wide ceiling over one bucket, as a multiple of the route's own limit; `0` switches it off (F-066-s). */
  PLATFORM_RATE_LIMIT_FACTOR: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().nonnegative().default(10),
  ),

  // Requests per user per the route's window (F-019-h). The read budget is the
  // package list plus the slug suggestion the purchase form asks as the name
  // is typed; the write budget is purchases, each of which moves money.
  RESELLER_PURCHASE_READ_RATE_LIMIT: rateLimit(120),
  RESELLER_PURCHASE_WRITE_RATE_LIMIT: rateLimit(10),
}).refine((env) => !(env.NODE_ENV === 'production' && !env.SERVICE_AUTH_TOKEN), {
  message: 'SERVICE_AUTH_TOKEN is required when NODE_ENV=production: without it no process can reach internal/*',
  path: ['SERVICE_AUTH_TOKEN'],
});

export type EnvConfig = z.infer<typeof envSchema>;

/** The variables a route may name as its `configKey`; a misspelled one does not compile (F-087). */
export type RateLimitConfigKey = Extract<keyof EnvConfig, `${string}_RATE_LIMIT`>;

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

/** `skipProcessEnv` for the reason `billing-service`'s schema gives. */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
