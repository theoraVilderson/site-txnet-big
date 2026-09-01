import { z } from 'zod';

const otpChannelsSchema = z
  .string()
  .default('sms')
  .transform((v) =>
    v
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  );

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // Every Redis key this service writes is prefixed with
  // `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`.
  // Bump REDIS_KEYSPACE_VERSION (v1 -> v2 -> ...) to abandon the whole
  // keyspace in one move — the old keys just expire on their own.
  REDIS_KEY_NAMESPACE: z
    .string()
    .min(1)
    .default('txnet:auth')
    // no trailing colon — it's added when the prefix is assembled
    .transform((v) => v.replace(/:+$/, '')),
  REDIS_KEYSPACE_VERSION: z.string().min(1).default('v1'),
  FRONTEND_ORIGIN: z.string().url().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(true),

  OTP_ALLOWED_CHANNELS: otpChannelsSchema,
  OTP_DEV_CONSOLE_LOG: z.coerce.boolean().default(false),
  // Shared timeout for every outgoing HTTP request to the bots (Bale/Telegram)
  OTP_BOT_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // --- Telegram Bot ---
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),

  // --- Bale Bot (Telegram-compatible API shape) ---
  BALE_BOT_TOKEN: z.string().optional(),
  BALE_API_BASE: z.string().url().default('https://tapi.bale.ai'),

  JWT_ACCESS_SECRET: z
    .string()
    .min(16, 'JWT_ACCESS_SECRET must be at least 16 characters long'),
  JWT_REFRESH_HASH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  OTP_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(300),
  RESET_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(300),
  IMPERSONATION_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(1800),

  LOCALES_DIR: z.string().default('./locales/langs'),
  LOCALES_WATCH: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY: z.string().default('1'),
  DEFAULT_LANGUAGE: z.string().default('fa'),

  // locale-service (gRPC source of truth)
  LOCALE_SERVICE_ADDR: z.string().default('localhost:50051'),
  LOCALE_SCOPE: z.string().default('backend'),
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
