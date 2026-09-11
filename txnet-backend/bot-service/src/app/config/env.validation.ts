import {
  AUTOMATION_EXCHANGE_DEFAULT,
  RedisTtl,
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  normalizeRedisNamespace,
} from '@txnet-backend/shared-core';
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
    .default(REDIS_KEY_NAMESPACE_DEFAULT)
    .transform(normalizeRedisNamespace),
  REDIS_KEYSPACE_VERSION: z
    .string()
    .min(1)
    .default(REDIS_KEYSPACE_VERSION_DEFAULT),

  /** Where auth-api answers, including its `/api` prefix-less host part. */
  AUTH_API_BASE_URL: z.string().url(),
  /** Sent as `X-Service-Token`; waives the captcha, re-buckets rate limits. */
  SERVICE_AUTH_TOKEN: z.string().min(32),
  /**
   * The tenant this bot serves, sent as `X-Tenant-Id` on every call out.
   *
   * A bot chat has no host, and `auth-api` has no fallback tenant (ADR-0025):
   * a call arriving from `http://auth-service:3001` matches no `tenant_domain`
   * row, so without this every bot flow is answered a neutral 404. The header
   * is honoured only from a verified service caller, which is why it is safe
   * to state rather than prove (`docs/domains/tenant/contract.md`).
   *
   * Optional, and a uuid when set — the id of a real `tenant` row, which
   * `prisma/seed.js` prints when it creates the platform owner. Leaving it
   * unset is not a fallback: the bot then names no tenant and auth-api refuses
   * it, loudly, which is the intended failure while an install is half
   * configured.
   *
   * One process, one tenant. F-066-h/F-066-i replace this with a per-
   * `BotIntegration` lookup, and the header stays exactly where it is.
   */
  BOT_TENANT_ID: optional(z.string().uuid()),
  AUTH_API_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  /** How long a chat stays signed in without touching the bot. */
  BOT_SESSION_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(RedisTtl.botSession),
  /** How long a half-finished conversation is remembered. */
  BOT_NAV_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(RedisTtl.botNav),

  /**
   * The broker the webhook enqueues onto (F-067-b). **Required**, unlike in
   * `auth-service`, where a publish is one route of many: this service serves
   * exactly one kind of caller and that caller's update now goes straight on a
   * queue, so a `bot-service` that cannot reach RabbitMQ can do nothing at all.
   * Failing at boot is louder than answering every update with a 503 that the
   * platform then retries for hours.
   */
  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
  /** The same topic exchange `worker-service` binds its queues to. */
  AUTOMATION_EXCHANGE: z
    .string()
    .min(1)
    .default(AUTOMATION_EXCHANGE_DEFAULT),
  /**
   * How many queues the bot-update set has, and so how many chats' updates can
   * be handled at once. **It must match `worker-service`'s** — this side
   * computes the routing key from it and that side asserts the queues, so a
   * publisher that thinks there are 8 addresses a queue nobody declared.
   *
   * Ordering within one chat is what the set buys (D-16): a chat always hashes
   * to one queue and that queue has one consumer holding one message at a
   * time. Raising this raises parallelism across chats and never within one.
   * A change is a re-shard, so raise it while the queues are drained — updates
   * in flight for a chat may be on its old queue while new ones go to the new.
   */
  BOT_UPDATE_QUEUES: z.coerce.number().int().positive().default(4),
  /**
   * How long a publish waits for the broker's confirm before the update is
   * treated as lost and the route answers 5xx (F-067-f, D-18). Same default and
   * same reasoning as `worker-service`'s: long against a healthy round trip,
   * short against the platform's own webhook timeout.
   */
  AUTOMATION_PUBLISH_CONFIRM_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),

  OTP_BOT_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  BOT_WEBHOOK_AUTO_REGISTER: z.enum(['true', 'false']).default('true'),
  BOT_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),
  DOMAIN_NAME: z.string().min(1, 'DOMAIN_NAME is required'),

  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  TELEGRAM_DEEP_LINK_BASE: z.string().url().default('https://t.me'),
  TELEGRAM_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  BALE_API_BASE: z.string().url().default('https://tapi.bale.ai'),
  BALE_DEEP_LINK_BASE: z.string().url().default('https://ble.ir'),
  BALE_WEBHOOK_PUBLIC_BASE: optional(z.string().url()),

  LOCALE_SERVICE_ADDR: z.string().default('localhost:50051'),
  LOCALE_SCOPE: z.string().default('backend'),
  DEFAULT_LANGUAGE: z.string().default('fa'),
  /**
   * The language this bot speaks before a user says otherwise. Optional because
   * `DEFAULT_LANGUAGE` already answers that question for the whole deployment;
   * set this only when the bot should differ from the rest of the platform
   * (ADR-0016, `locale/chat-language.ts`). Unset does *not* mean "follow the
   * messenger" — the messenger's hint is the last resort, not the first.
   */
  BOT_DEFAULT_LANGUAGE: optional(z.string()),
  /** Idle TTL on a chat's `/lang` choice. Defaults to `RedisTtl.botLang`. */
  BOT_LANG_TTL_SEC: optional(z.coerce.number().int().positive()),
  /**
   * The region a number typed into the chat without a `+` belongs to. Unset,
   * it follows the language the bot speaks, the same way `auth-service` reads
   * it from `DEFAULT_LANGUAGE` (ADR-0018, `flows/phone-number.ts`) — so a
   * deployment normally sets it once, for both services, or not at all.
   */
  DEFAULT_PHONE_COUNTRY: optional(z.string()),
  /**
   * Which languages the messenger's own command menu is registered in
   * (`webhook/bot-webhook.registrar.ts`). Comma-separated; defaults to `fa,en`.
   */
  BOT_COMMAND_LANGS: optional(z.string()),
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

/**
 * How every process in this service reads its environment — one object so the
 * app and its tests cannot drift apart on it.
 *
 * `skipProcessEnv` is the load-bearing part. Docker compose passes each
 * optional variable as `VAR=${VAR:-}`, so "unset" arrives as the empty string;
 * `optional()` above turns that back into `undefined`, but `ConfigService.get`
 * consults the validated env *first and `process.env` second*, so an undefined
 * validated value fell straight through to the raw `''` and no default — the
 * schema's or the call site's — ever ran. `BOT_LANG_TTL_SEC` then reached
 * Redis as `expire <key> ''`, an error reply, and every webhook update
 * answered 500. Making the validated env the only source is what the schema
 * was written to be.
 */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
