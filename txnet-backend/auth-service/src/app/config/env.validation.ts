import {
  AUTOMATION_EXCHANGE_DEFAULT,
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  normalizeRedisNamespace,
} from '@txnet-backend/shared-core';
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

/**
 * A per-route request limit: a positive whole number with a default.
 *
 * The empty string counts as unset, for the reason `optional` above exists —
 * compose passes `VAR=${VAR:-}`, and `''` coerced to a number is `0`, which
 * would fail validation for a variable nobody set.
 */
const rateLimit = (fallback: number) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(fallback),
  );

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  // The migration/owner connection. Prisma's CLI reads it by name
  // (`datasource db { url = env("DATABASE_URL") }`), so it stays; the running
  // service does not use it.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // What the service actually connects with: a login role that owns no table
  // and carries NOBYPASSRLS, so the Row-Level Security policies apply to it
  // (F-066-m-a). Required, and deliberately without a fallback to
  // `DATABASE_URL` — falling back would silently restore the state RLS exists
  // to end, and nothing would look wrong.
  DATABASE_APP_URL: z.string().min(1, 'DATABASE_APP_URL is required'),
  // The second pool (F-066-m-b): the login role whose policy is `USING (true)`,
  // for the handful of reads that resolve a tenant and so cannot run inside
  // one — host -> tenant, webhook path -> bot, credential -> DEK. Required for
  // the same reason as the one above and with no fallback for a stronger one:
  // pointing it at `DATABASE_APP_URL` makes domain resolution and the vault
  // return nothing, and pointing it at `DATABASE_URL` un-does the whole layer.
  DATABASE_CROSS_TENANT_URL: z
    .string()
    .min(1, 'DATABASE_CROSS_TENANT_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // Every Redis key this service writes is prefixed with
  // `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`.
  // Bump REDIS_KEYSPACE_VERSION (v1 -> v2 -> ...) to abandon the whole
  // keyspace in one move — the old keys just expire on their own.
  REDIS_KEY_NAMESPACE: z
    .string()
    .min(1)
    .default(REDIS_KEY_NAMESPACE_DEFAULT)
    // no trailing colon — it's added when the prefix is assembled
    .transform(normalizeRedisNamespace),
  REDIS_KEYSPACE_VERSION: z
    .string()
    .min(1)
    .default(REDIS_KEYSPACE_VERSION_DEFAULT),
  FRONTEND_ORIGIN: optional(z.string().url()),
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
  // On boot, point every tenant's bot at this service's own webhook path.
  BOT_WEBHOOK_AUTO_REGISTER: z.enum(['true', 'false']).default('true'),
  // Where a platform reaches this service, when it is not `https://api.<domain>`
  // — a dev tunnel, or another app fronting this API. A platform that needs its
  // own way in overrides this with `<PLATFORM>_WEBHOOK_PUBLIC_BASE`.
  BOT_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  // --- Telegram Bot ---
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  // The deep-link host. The bot's username comes from its `BotIntegration`
  // row now, not from here (F-066-i).
  TELEGRAM_DEEP_LINK_BASE: z.string().url().default('https://t.me'),
  // Incoming side: the base Telegram calls back on. Its servers cannot open a
  // connection to every host, so this is usually a proxy in front of the API.
  TELEGRAM_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  // --- Bale Bot (Telegram-compatible API shape) ---
  BALE_API_BASE: z.string().url().default('https://tapi.bale.ai'),
  BALE_DEEP_LINK_BASE: z.string().url().default('https://ble.ir'),
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
  // ---- Per-route request limits (F-087) ----------------------------------
  //
  // Decided 2026-09-11: **every** `@RateLimit` route's limit is deployment
  // config, and every one has a default. Tightening login throttling under
  // attack used to need a rebuild and a redeploy for 19 of 22 routes.
  //
  // The default lives here and nowhere else — not on the decorator, not in
  // docker-compose — so there is one number per limit. A route names its
  // variable with a `configKey` typed as `RateLimitConfigKey`, which is why a
  // misspelled name is a compile error instead of a silent fall-back to a
  // default. Each value is requests per subject per that route's window; the
  // windows stay on the routes (`auth-api/contract.rate-limits.md`). The
  // platform-wide ceiling above scales from these, so raising one raises its
  // ceiling too.
  LOGIN_PWD_RATE_LIMIT: rateLimit(20),
  LOGIN_OTP_REQUEST_RATE_LIMIT: rateLimit(10),
  LOGIN_OTP_VERIFY_RATE_LIMIT: rateLimit(20),
  REGISTER_RATE_LIMIT: rateLimit(10),
  REGISTER_VERIFY_RATE_LIMIT: rateLimit(20),
  PASSWORD_FORGOT_RATE_LIMIT: rateLimit(10),
  // Password-reset OTP verifications per subject per window — the budget for
  // guessing a 6-digit reset code.
  FORGOT_VERIFY_RATE_LIMIT: rateLimit(20),
  OTP_DELIVERY_STATUS_RATE_LIMIT: rateLimit(120),
  OTP_CHANNELS_RATE_LIMIT: rateLimit(60),
  // Captcha challenges + verifications per IP per window, one budget for both
  // routes. It gates every guarded route, so it is the ceiling on how fast a
  // client may work at all.
  CAPTCHA_RATE_LIMIT: rateLimit(30),
  BOT_LINK_RESOLVE_RATE_LIMIT: rateLimit(30),
  BOT_LINK_CONTACT_RATE_LIMIT: rateLimit(10),
  BOT_LINK_STATUS_RATE_LIMIT: rateLimit(300),
  BOT_SESSION_RATE_LIMIT: rateLimit(10),
  BOT_WEBAPP_SESSION_RATE_LIMIT: rateLimit(20),
  ACCOUNTS_ADD_OTP_REQUEST_RATE_LIMIT: rateLimit(10),
  ACCOUNTS_ADD_OTP_VERIFY_RATE_LIMIT: rateLimit(20),
  ACCOUNTS_ADD_PASSWORD_RATE_LIMIT: rateLimit(20),
  ACCOUNTS_LIST_RATE_LIMIT: rateLimit(120),
  ACCOUNTS_SWITCH_RATE_LIMIT: rateLimit(30),
  ACCOUNTS_REMOVE_RATE_LIMIT: rateLimit(30),
  // The platform-wide ceiling over every guarded route's bucket, as a
  // multiple of that route's own per-tenant limit (F-066-s). Per-tenant
  // buckets hand one IP a fresh budget for every tenant it can name, so this
  // is what caps the total; a caller behind a large NAT that legitimately
  // uses many resellers is the reason it is a multiple and not `1`. `0`
  // switches the ceiling off and writes no platform counter at all.
  PLATFORM_RATE_LIMIT_FACTOR: z.coerce.number().int().nonnegative().default(10),

  // There is deliberately no DEFAULT_TENANT_SLUG here. A request resolves its
  // tenant from a `tenant_domain` row or from a claim it carries, and nothing
  // else — a host that matches neither is answered a neutral 404 (ADR-0025,
  // F-1210). A fallback cannot tell a misconfigured host from an unknown one,
  // so it served every stray host as the platform owner.

  // The Credential Vault's KEK (ADR-0026). This is a **path to a mounted
  // secret**, never the key itself: a value here would be visible in
  // `docker inspect`, in `/proc/<pid>/environ` and in every child process.
  // Unset means the vault is unavailable and every credential operation is
  // refused — the service still boots, because no tenant credential is stored
  // anywhere yet (F-066-i is what starts writing them).
  VAULT_KEK_FILE: optional(z.string().min(1)),

  LOCALES_DIR: z.string().default('./locales/langs'),
  LOCALES_WATCH: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY: z.string().default('1'),
  DEFAULT_LANGUAGE: z.string().default('fa'),

  // Phone numbers (ADR-0018). Both optional and both read by
  // `common/validation/phone.schema.ts`; declared here so a deployment
  // configures them in the one place every other setting lives.
  // Empty SUPPORTED_PHONE_COUNTRIES means every country the library knows.
  DEFAULT_PHONE_COUNTRY: optional(z.string().length(2)),
  SUPPORTED_PHONE_COUNTRIES: z.string().optional(),

  // locale-service (gRPC source of truth)
  LOCALE_SERVICE_ADDR: z.string().default('localhost:50051'),
  LOCALE_SCOPE: z.string().default('backend'),

  // The automation exchange, for the one message this process publishes: an
  // `admin_manual` tick (F-031-b, ADR-0027). `RABBITMQ_URL` is **optional
  // here and required in `worker-service`**, and the asymmetry is deliberate:
  // a worker with no broker has nothing to do, while this process answers
  // logins and must boot without one. Unset, `POST /admin/workers/:key/run`
  // answers 503 and nothing else is affected.
  RABBITMQ_URL: optional(z.string().min(1)),
  AUTOMATION_EXCHANGE: z
    .string()
    .min(1)
    .default(AUTOMATION_EXCHANGE_DEFAULT),
  // How long that publish waits to be confirmed before the route answers 503
  // (F-067-f, D-18). Same default as `worker-service`, and the same reason for
  // bounding it at all: an unanswered publish must fail the caller rather than
  // hold a request open.
  AUTOMATION_PUBLISH_CONFIRM_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * The env variables that hold a per-route request limit. `@RateLimit` takes one
 * of these as `configKey`, so a route cannot name a variable the schema does
 * not declare — and every declared one has a default (F-087).
 */
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
