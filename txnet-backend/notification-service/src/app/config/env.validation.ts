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
 * `notification-service`'s environment, validated at boot (F-089, ADR-0036).
 *
 * `billing-service`'s schema with everything billing-specific left out: no
 * vault, and no resolving a tenant (the gate forwards one). Each variable says why it is required or why an empty value is safe.
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
   * The cross-tenant role (F-035-c): a platform-wide campaign cannot be
   * written on the app pool (`prisma/cross-tenant-prisma.service.ts`).
   * Required, as in `billing-service`.
   */
  DATABASE_CROSS_TENANT_URL: z.string().min(1, 'DATABASE_CROSS_TENANT_URL is required'),

  /** The panel's origin, for CORS with credentials; required in production (`main.ts`). */
  FRONTEND_ORIGIN: z.string().default(''),

  /**
   * The platform's own processes, proving themselves to `internal/*`
   * (`ServiceOnlyGuard`, ADR-0011) — how another unit creates a notification.
   * Empty closes the seam, so it is required in production.
   */
  SERVICE_AUTH_TOKEN: z.string().default(''),

  /**
   * Where a campaign's bot is resolved and its token read (F-035-e): the
   * `internal/bot-integrations` seam, with `SERVICE_AUTH_TOKEN`. Empty boots —
   * inbox and drafts need nothing from it — and every Telegram/Bale send stays
   * `queued` and counted as stalled until it is set.
   */
  AUTH_API_BASE_URL: z.string().default(''),
  AUTH_API_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  /** The bot API bases `messenger` sends to; unset is the public ones (`bot-client.registry.ts`). */
  TELEGRAM_API_BASE: z.string().url().optional(),
  BALE_API_BASE: z.string().url().optional(),
  /** Per send, as for the OTP senders (`messenger`'s registry reads it). */
  OTP_BOT_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /**
   * The platform's SMS line (F-035-f, D-38): the OTP gateway's, the same names
   * as `auth-service` (graced in `credential-env.ts` until F-018). Empty boots,
   * and every SMS row stays `queued` and counted as stalled until both are set.
   */
  SMS_API_URL: z.string().default(''),
  SMS_API_KEY: z.string().default(''),
  SMS_SENDER: z.string().default(''),

  /**
   * The platform's mail server (F-035-h, D-38 as for SMS): `auth-service`'s
   * names (D-39). Unset `SMTP_HOST` or `MAIL_FROM` boots, and every email row
   * stays `queued` and counted as stalled until both are set.
   */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default(''),

  /** The envelope's translator (`locale/locale.service.ts`). */
  LOCALE_SERVICE_ADDR: z.string().min(1).default('localhost:50051'),
  LOCALE_SCOPE: z.string().min(1).default('backend'),
  DEFAULT_LANGUAGE: z.string().min(1).default('fa'),

  /** The rate limiter's counters (F-092-r, D-24): required, for billing's reason. */
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

  // Requests per user per the route's window. The dropdown polls the list
  // until F-035-b pushes instead, so the read budget is a polling budget.
  NOTIFICATION_READ_RATE_LIMIT: rateLimit(300),
  NOTIFICATION_WRITE_RATE_LIMIT: rateLimit(120),
  // Campaign management (F-035-c): an admin's form, not a poll.
  NOTIFICATION_CAMPAIGN_READ_RATE_LIMIT: rateLimit(300),
  NOTIFICATION_CAMPAIGN_WRITE_RATE_LIMIT: rateLimit(60),
}).refine((env) => !(env.NODE_ENV === 'production' && !env.SERVICE_AUTH_TOKEN), {
  message: 'SERVICE_AUTH_TOKEN is required when NODE_ENV=production: without it no other unit can create a notification',
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
