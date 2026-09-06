import { z } from 'zod';

/**
 * `bot-service` holds no database credentials and no JWT secret: it is a
 * surface, and every decision it needs comes from `auth-api` over HTTP
 * (ADR-0009). What it does need is a way in (the bot tokens), a way out
 * (`AUTH_API_BASE_URL` + `SERVICE_AUTH_TOKEN`), Redis for conversation state,
 * and locale-service for every string it says.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3002),
  TRUST_PROXY: z.string().default('1'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // Same namespace + version as auth-service, so one bump abandons every
  // key this platform holds at once (ADR-0005, C-03).
  REDIS_KEY_NAMESPACE: z
    .string()
    .min(1)
    .default('txnet:auth')
    .transform((v) => v.replace(/:+$/, '')),
  REDIS_KEYSPACE_VERSION: z.string().min(1).default('v1'),

  /** Where auth-api answers, including its `/api` prefix-less host part. */
  AUTH_API_BASE_URL: z.string().url(),
  /** Sent as `X-Service-Token`; waives the captcha, re-buckets rate limits. */
  SERVICE_AUTH_TOKEN: z.string().min(32),
  AUTH_API_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  /** How long a chat stays signed in without touching the bot. */
  BOT_SESSION_TTL_SEC: z.coerce.number().int().positive().default(30 * 24 * 3600),
  /** How long a half-finished conversation is remembered. */
  BOT_NAV_TTL_SEC: z.coerce.number().int().positive().default(30 * 60),

  OTP_BOT_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  BOT_WEBHOOK_AUTO_REGISTER: z.enum(['true', 'false']).default('true'),
  BOT_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),
  DOMAIN_NAME: z.string().min(1, 'DOMAIN_NAME is required'),

  TELEGRAM_BOT_TOKEN: optional(z.string()),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  TELEGRAM_BOT_USERNAME: optional(z.string()),
  TELEGRAM_DEEP_LINK_BASE: z.string().url().default('https://t.me'),
  TELEGRAM_WEBHOOK_SECRET: optional(z.string().min(16)),
  TELEGRAM_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  BALE_BOT_TOKEN: optional(z.string()),
  BALE_API_BASE: z.string().url().default('https://tapi.bale.ai'),
  BALE_BOT_USERNAME: optional(z.string()),
  BALE_DEEP_LINK_BASE: z.string().url().default('https://ble.ir'),
  BALE_WEBHOOK_SECRET: optional(z.string().min(16)),
  BALE_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  LOCALE_SERVICE_ADDR: z.string().default('localhost:50051'),
  LOCALE_SCOPE: z.string().default('backend'),
  DEFAULT_LANGUAGE: z.string().default('fa'),
  /**
   * The language this bot speaks before a user says otherwise. Unset means
   * "follow the messenger's own language" — which is why it is separate from
   * `DEFAULT_LANGUAGE`, the last-resort fallback that is always set
   * (`locale/chat-language.ts`).
   */
  BOT_DEFAULT_LANGUAGE: z.string().optional(),
  BOT_LANG_TTL_SEC: z.coerce.number().int().positive().optional(),
  /** The panel, for the `escape` link a view may offer alongside the chat. */
  PANEL_BASE_URL: optional(z.string().url()),
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
