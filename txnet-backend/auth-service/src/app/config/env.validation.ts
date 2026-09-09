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

/**
 * An optional var that docker compose passes through as `FOO=` when it is
 * unset arrives as an empty string, not as absent — and `""` fails every
 * length rule, so the service would refuse to boot over a variable nobody
 * filled in on purpose. Treat empty as "not set".
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

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
  DOMAIN_NAME: z.string().min(1, 'DOMAIN_NAME is required'),
  COOKIE_SECURE: z.coerce.boolean().default(true),

  // The channels this environment may deliver an OTP through. A channel that
  // is not listed here is invisible: it is never offered to a client by
  // `GET /auth/otp/channels` and is rejected if asked for by name. A listed
  // channel still has to be *configured* (a bot token / SMS credentials) to
  // count as available — see `OtpChannelRegistry`.
  OTP_ALLOWED_CHANNELS: otpChannelsSchema,
  // 'console' skips every real sender and prints the code instead (dev).
  OTP_DELIVERY_MODE: z.enum(['live', 'console']).default('live'),
  OTP_DEV_CONSOLE_LOG: z.coerce.boolean().default(false),
  // Shared timeout for every outgoing HTTP request to the bots (Bale/Telegram)
  OTP_BOT_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // How long a bot-link deep link stays usable before the user must ask for a
  // new one. Also the TTL of the pending-link record in Redis.
  BOT_LINK_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  // On boot, point every configured bot at this service's own webhook route.
  BOT_WEBHOOK_AUTO_REGISTER: z.enum(['true', 'false']).default('true'),
  // Where a platform reaches this service, when it is not `https://api.<domain>`
  // — a dev tunnel, or another app fronting this API. A platform that needs its
  // own way in overrides this with `<PLATFORM>_WEBHOOK_PUBLIC_BASE`.
  BOT_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  // --- Telegram Bot ---
  TELEGRAM_BOT_TOKEN: optional(z.string()),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  // Bot username without '@' — only used to build the ?start=<token> deep link.
  TELEGRAM_BOT_USERNAME: optional(z.string()),
  TELEGRAM_DEEP_LINK_BASE: z.string().url().default('https://t.me'),
  // Shared secret in the webhook path (and, for Telegram, also checked against
  // the X-Telegram-Bot-Api-Secret-Token header when the platform sends one).
  // Without it the platform's webhook route refuses every update.
  TELEGRAM_WEBHOOK_SECRET: optional(z.string().min(16)),
  // Incoming side: the base Telegram calls back on. Its servers cannot open a
  // connection to every host, so this is usually a proxy in front of the API.
  TELEGRAM_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  // --- Bale Bot (Telegram-compatible API shape) ---
  BALE_BOT_TOKEN: optional(z.string()),
  BALE_API_BASE: z.string().url().default('https://tapi.bale.ai'),
  BALE_BOT_USERNAME: optional(z.string()),
  BALE_DEEP_LINK_BASE: z.string().url().default('https://ble.ir'),
  BALE_WEBHOOK_SECRET: optional(z.string().min(16)),
  BALE_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  // Shared secret another service of this platform (bot-service) sends as
  // `X-Service-Token`. It waives the captcha and re-buckets the rate limit —
  // nothing else. Unset means no service may call: the captcha stands for
  // everyone. See ADR-0011.
  SERVICE_AUTH_TOKEN: optional(z.string().min(32)),

  JWT_ACCESS_SECRET: z
    .string()
    .min(16, 'JWT_ACCESS_SECRET must be at least 16 characters long'),
  JWT_REFRESH_HASH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  OTP_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(300),
  RESET_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(300),
  IMPERSONATION_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(1800),

  // --- Abuse limits ---
  // Deployment config, not compile-time constants: a white-label deployment
  // with a different risk appetite changes these without a rebuild. Today's
  // values are the defaults, so an environment that sets none of them behaves
  // exactly as the constants did. `auth-api`'s contract carries the same
  // three, which is why they are named there and not only here.
  //
  // How many failed passwords lock ONE account (not the caller's IP) for
  // `LOGIN_FAILURE_WINDOW_SEC`. Raising it makes guessing cheaper; lowering it
  // makes a forgetful user easier to lock out on purpose.
  LOGIN_FAILURE_LOCK_THRESHOLD: z.coerce.number().int().positive().default(10),
  // Captcha challenges + verifications per IP per window. It gates every
  // guarded route, so it is the ceiling on how fast a client may work at all.
  CAPTCHA_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  // Password-reset OTP verifications per subject per window — the budget for
  // guessing a 6-digit reset code.
  FORGOT_VERIFY_RATE_LIMIT: z.coerce.number().int().positive().default(20),

  LOCALES_DIR: z.string().default('./locales/langs'),
  LOCALES_WATCH: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY: z.string().default('1'),
  DEFAULT_LANGUAGE: z.string().default('fa'),

  // Phone numbers (ADR-0018). Both optional and both read by
  // `common/validation/phone.schema.ts`; declared here so a deployment
  // configures them in the one place every other setting lives.
  // Empty SUPPORTED_PHONE_COUNTRIES means every country the library knows.
  DEFAULT_PHONE_COUNTRY: z.string().length(2).optional(),
  SUPPORTED_PHONE_COUNTRIES: z.string().optional(),

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
