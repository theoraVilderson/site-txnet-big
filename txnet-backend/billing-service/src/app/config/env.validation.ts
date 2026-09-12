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
 * `billing-service`'s environment, validated at boot (F-089, ADR-0036).
 *
 * **Why a scaffold gets a schema before it gets features.** This was the one Nx
 * application on the platform with no env validation at all: `main.ts` read
 * `process.env.PORT` raw and logged a hardcoded `http://localhost:<port>`. The
 * other four each have a zod `envSchema` behind `ConfigService`, so this was
 * also the only deployable that could start with a typo'd variable and report
 * itself healthy.
 *
 * Doing it now is cheap and doing it later is not. F-039 fills this service in;
 * at that point there are call sites reading `process.env` directly and the
 * change becomes a migration instead of a file. The schema is deliberately
 * small — what exists today plus the shape the next variable slots into — and
 * not a guess at what billing will need. Adding a field nobody asked for is how
 * a config schema becomes a list of things that are never set.
 *
 * Modelled on `gateway-service/src/app/config/env.validation.ts`.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * The prefix every route sits under. A constant in `main.ts` until now, and
   * configuration here for the same reason the port is: it is part of the
   * address Traefik routes to, and an address the image cannot be told about
   * is one that needs a rebuild to change.
   */
  GLOBAL_PREFIX: z.string().min(1).default('api'),

  /**
   * The host this service reports itself reachable at, for the boot log only.
   *
   * `main.ts` logged `http://localhost:<port>` unconditionally, which is wrong
   * in every environment where it matters: inside a container `localhost` is
   * the container, and the line an operator reads after a deploy pointed at an
   * address nothing outside could reach.
   */
  PUBLIC_HOST: z.string().min(1).default('localhost'),

  /**
   * The connection the service queries with (F-092-a): a login role that owns
   * nothing and carries `NOBYPASSRLS`, so the Row-Level Security policies bind.
   * Required, with no fallback to `DATABASE_URL` — the owner connection, which
   * RLS does not apply to. A fallback here is a silent return to no isolation,
   * the reasoning `auth-service`'s schema gives for the same variable.
   */
  DATABASE_APP_URL: z.string().min(1, 'DATABASE_APP_URL is required'),

  /**
   * The second pool, for the one read that resolves a tenant instead of running
   * inside one (F-092-j): which tenant owns the host a bank redirected a
   * browser to. Required, and pointed at `txnet_cross_tenant_user` — pointing
   * it at `DATABASE_APP_URL` makes every gateway callback a 404, and pointing
   * it at `DATABASE_URL` un-does the isolation layer. `auth-service`'s schema
   * says the same about the same variable.
   */
  DATABASE_CROSS_TENANT_URL: z
    .string()
    .min(1, 'DATABASE_CROSS_TENANT_URL is required'),

  /**
   * The panel's origin, for CORS with credentials (F-093-c). Comma-separated.
   *
   * This service shipped with no CORS at all and a comment saying the panel
   * reached it "through its own API proxy, never from the browser". The panel
   * had removed that proxy a week earlier and lists it under Deprecations
   * (`panel-web/contract.md`): server-to-server was the source of an
   * intermittent 502, so every call from the browser now goes cross-origin to
   * `api.<domain>` with the access token as a Bearer header. Nothing was red,
   * because until F-093-c no panel screen had asked billing for anything.
   *
   * Required in production, exactly as `auth-service` requires it: a missing
   * origin there means fail-closed, never "allow any origin" — a wallet route
   * readable by any page on the internet that can borrow a session is worse
   * than one no page can reach.
   */
  FRONTEND_ORIGIN: z.string().default(''),

  /** The envelope's translator (`locale/locale.service.ts`). */
  LOCALE_SERVICE_ADDR: z.string().min(1).default('localhost:50051'),
  LOCALE_SCOPE: z.string().min(1).default('backend'),
  DEFAULT_LANGUAGE: z.string().min(1).default('fa'),

  /**
   * The Credential Vault's KEK — a **path to a mounted secret**, never the key
   * (ADR-0026). The same file `auth-service` mounts: this service decrypts a
   * gateway's merchant id itself (ADR-0039). Unset, the service boots and every
   * gateway call that needs a merchant id is refused. Compose passes an unset
   * variable as `''`, which `KekService` reads as unset.
   */
  VAULT_KEK_FILE: z.string().default(''),

  /**
   * Every gateway driver talks to its provider's sandbox (F-092-f). Per
   * environment, never per tenant. Refused in production: a sandbox that
   * "verifies" a payment credits a wallet with money that never moved.
   */
  PAYMENT_GATEWAY_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * The rate limiter's counters (F-092-r, D-24). Required: a limit counted in
   * process memory is one budget per replica, and a route with no counter is
   * unlimited — refusing to boot is the only honest answer. The same keyspace
   * prefix every service writes under, so one `REDIS_KEYSPACE_VERSION` bump
   * abandons every key (ADR-0005).
   */
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_KEY_NAMESPACE: z.string().min(1).default(REDIS_KEY_NAMESPACE_DEFAULT),
  REDIS_KEYSPACE_VERSION: z
    .string()
    .min(1)
    .default(REDIS_KEYSPACE_VERSION_DEFAULT),

  /**
   * How long a `pending` payment stays payable, and with it the coupon holds it
   * took (F-092-i). Legacy gave the row a 20-minute Mongo TTL and its coupon
   * locks a separate one, which is how a lock could outlive its payment; here
   * there is one clock and F-092-k reads it.
   */
  PAYMENT_PENDING_TTL_SEC: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(900),
  ),

  /**
   * One callback origin for every tenant, instead of the tenant's own panel
   * domain (F-092-i). Development and test only: no tenant owns a host a
   * gateway's sandbox can reach, and `https://<domainValue>` would send the
   * browser nowhere. Unset in production, where ADR-0020 wants a reseller's
   * customer back on the brand they paid on.
   */
  PAYMENT_CALLBACK_ORIGIN: z.string().default(''),

  /** The platform-wide ceiling over one bucket, as a multiple of the route's own limit; `0` switches it off (F-066-s). */
  PLATFORM_RATE_LIMIT_FACTOR: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().nonnegative().default(10),
  ),

  // Requests per user per the route's window (the windows stay on the routes).
  // The defaults live here and nowhere else (F-087).
  DEPOSIT_GATEWAYS_RATE_LIMIT: rateLimit(120),
  DEPOSIT_QUOTE_RATE_LIMIT: rateLimit(60),
  /** Each call holds coupons and mints an authority at the bank (`payment/deposit/deposit-start.service.ts`). */
  DEPOSIT_START_RATE_LIMIT: rateLimit(20),
  /**
   * The gateway callback (`payment/deposit/deposit-callback.controller.ts`),
   * counted per **authority** rather than per user: it is the platform's only
   * public billing route, and a bank redirecting a browser carries no identity
   * to bucket on. One authority is one payment, so this is how many times a
   * single payment may be presented for settlement in a quarter of an hour —
   * generous enough for a user reloading the result page, and far below what it
   * costs to make a second authority.
   */
  DEPOSIT_CALLBACK_RATE_LIMIT: rateLimit(30),
  WALLET_HISTORY_RATE_LIMIT: rateLimit(180),
  WALLET_PAYMENTS_RATE_LIMIT: rateLimit(120),
  /** A code-guessing oracle if it were generous (`payment/gift/gift.controller.ts`). */
  GIFT_REDEEM_RATE_LIMIT: rateLimit(10),
}).refine((env) => !(env.NODE_ENV === 'production' && env.PAYMENT_GATEWAY_SANDBOX), {
  message: 'PAYMENT_GATEWAY_SANDBOX=true is refused when NODE_ENV=production',
  path: ['PAYMENT_GATEWAY_SANDBOX'],
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

/**
 * `skipProcessEnv` for the reason the other three services document: compose
 * passes every optional variable as `VAR=${VAR:-}`, so an unset option arrives
 * as the empty string, and `ConfigService.get` reads the validated env first
 * and `process.env` second — without this it would prefer that raw `''` to the
 * schema's default.
 */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
