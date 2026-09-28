import {
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
} from '@txnet-backend/shared-core';
import { z } from 'zod';

const rateLimit = (fallback: number) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(fallback),
  );

/** currency-service's environment (ADR-0100). Validated once, at boot. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  GLOBAL_PREFIX: z.string().min(1).default('api'),
  PUBLIC_HOST: z.string().min(1).default('localhost'),

  /** The app role, `NOBYPASSRLS` — the `currency` schema has no row policy. */
  DATABASE_APP_URL: z.string().min(1, 'DATABASE_APP_URL is required'),

  FRONTEND_ORIGIN: z.string().default(''),

  LOCALE_SERVICE_ADDR: z.string().min(1).default('localhost:50051'),
  LOCALE_SCOPE: z.string().min(1).default('backend'),
  DEFAULT_LANGUAGE: z.string().min(1).default('fa'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_KEY_NAMESPACE: z.string().min(1).default(REDIS_KEY_NAMESPACE_DEFAULT),
  REDIS_KEYSPACE_VERSION: z.string().min(1).default(REDIS_KEYSPACE_VERSION_DEFAULT),

  /** The platform tenant's multiplier on every limit, as in tenant-service. */
  PLATFORM_RATE_LIMIT_FACTOR: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().nonnegative().default(10),
  ),
  /** Reads of the rates, per caller per minute. */
  CURRENCY_READ_RATE_LIMIT: rateLimit(120),
  /** Pins and early ends, per admin per 15 minutes (F-0608-a). */
  CURRENCY_PIN_WRITE_RATE_LIMIT: rateLimit(30),

  TRUST_PROXY: z.string().default(''),

  /**
   * billing-service's internal base (F-116-j): which currencies a tenant's
   * gateways charge in. Unset, a tenant pins only its operating currency.
   */
  BILLING_API_BASE_URL: z.string().default(''),
  BILLING_API_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  /** The service token billing's `internal/*` requires. */
  SERVICE_AUTH_TOKEN: z.string().default(''),
});

export type EnvConfig = z.infer<typeof envSchema>;

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

/** `skipProcessEnv`: compose passes an unset option as '' (see bot-service). */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
