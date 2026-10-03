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

/** support-service's environment (ADR-0112). Validated once, at boot. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  GLOBAL_PREFIX: z.string().min(1).default('api'),
  PUBLIC_HOST: z.string().min(1).default('localhost'),

  /** The app role, `NOBYPASSRLS`: every `support` table is under RLS. */
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
  /** Reads (lists, messages, categories, mark read), per user per minute. */
  SUPPORT_READ_RATE_LIMIT: rateLimit(120),
  /** New conversations, per user per hour (ADR-0112 point 10). */
  SUPPORT_OPEN_RATE_LIMIT: rateLimit(10),
  /** Messages sent, per user per minute. */
  SUPPORT_SEND_RATE_LIMIT: rateLimit(30),
  /** Conversations a user may have unfinished (not resolved or closed) at once. */
  SUPPORT_UNFINISHED_MAX: rateLimit(5),

  TRUST_PROXY: z.string().default(''),
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
