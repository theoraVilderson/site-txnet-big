import {
  AUTOMATION_EXCHANGE_DEFAULT,
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  localeEnv,
} from '@txnet-backend/shared-core';
import { z } from 'zod';

const rateLimit = (fallback: number) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(fallback),
  );

/**
 * `ai-service` — the revenue engine and, later, the tenant's own model
 * (ADR-0109 point 2). It holds two pools and a broker, and no secret of any
 * other unit: no JWT secret, no vault key, no cross-tenant pool.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * The writer: `ai.*` and `engagement.attention_budget`, on the app role
   * (NOBYPASSRLS), with the tenant bound per run. Never `DATABASE_URL`, which
   * owns every table and leaves RLS inert (F-066-m-a).
   */
  DATABASE_APP_URL: z.string().min(1, 'DATABASE_APP_URL is required'),

  /**
   * The reader (ADR-0109 point 6): `txnet_ai_reader_user`, SELECT on the
   * tables `reader-tables.ts` names and nothing else, under tenant RLS. No
   * fallback to the app pool — that one may write, and a reader that silently
   * became a writer is the failure this role exists to rule out.
   */
  DATABASE_AI_READER_URL: z.string().min(1, 'DATABASE_AI_READER_URL is required'),

  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
  /** The exchange every automation message rides (F-079). */
  AUTOMATION_EXCHANGE: z.string().min(1).default(AUTOMATION_EXCHANGE_DEFAULT),
  /** Where a trigger that cannot be handled goes (F-067-d). */
  AUTOMATION_DLX: z.string().min(1).default('txnet.automation.dlx'),
  /** This service's own queue, bound to `AI_TRIGGER_EVENTS` — its own, so a slow engine never delays a notice. */
  AI_QUEUE: z.string().min(1).default('txnet.ai.triggers'),
  /** Low: the container has one CPU, and the host also serves the live site and bot (ADR-0109 point 2). */
  AI_PREFETCH: z.coerce.number().int().positive().max(50).default(4),

  /**
   * Opens `/api/internal/ai/*` to `worker-service` (the hourly rebuild, F-038-c).
   * Optional for the reason the worker gives its seams: unset, the route
   * refuses everyone with a 404, and the job's own run fails loudly.
   */
  SERVICE_AUTH_TOKEN: z.string().optional(),

  /** The shared envelope's translator (F-038-j0): `locale-service`, as every Nest service reads it. */
  ...localeEnv,
  DEFAULT_LANGUAGE: z.string().min(1).default('fa'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_KEY_NAMESPACE: z.string().min(1).default(REDIS_KEY_NAMESPACE_DEFAULT),
  REDIS_KEYSPACE_VERSION: z.string().min(1).default(REDIS_KEYSPACE_VERSION_DEFAULT),

  /** The platform tenant's multiplier on every limit, as in tenant-service. */
  PLATFORM_RATE_LIMIT_FACTOR: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().nonnegative().default(10),
  ),
  /** The suggestion card's read, per user per 15 minutes (F-038-h). */
  AI_SUGGESTION_READ_RATE_LIMIT: rateLimit(120),
  /** Dismiss and opt-out from the card, per user per 15 minutes (F-038-h). */
  AI_SUGGESTION_WRITE_RATE_LIMIT: rateLimit(30),
});

export type EnvConfig = z.infer<typeof envSchema>;
export type RateLimitConfigKey = Extract<keyof EnvConfig, `${string}_RATE_LIMIT`>;

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Environment validation failed — see log above');
  }
  if (parsed.data.DATABASE_AI_READER_URL === parsed.data.DATABASE_APP_URL) {
    throw new Error('DATABASE_AI_READER_URL must be the read-only role, not the app pool');
  }
  return parsed.data;
}

/** `skipProcessEnv` for the reason `metering-service` documents: compose passes unset options as `''`. */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
