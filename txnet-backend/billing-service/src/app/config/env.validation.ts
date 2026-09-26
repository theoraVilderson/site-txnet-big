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

  /**
   * The platform's own processes, proving themselves to the internal seam
   * (`ServiceOnlyGuard`, ADR-0011). `worker-service`'s expiry tick is the only
   * caller today (F-092-k).
   *
   * Empty closes the seam rather than opening it: the guard answers 404 to
   * everything, which is the safe direction but also a sweep that silently
   * never runs — so it is **required in production**, like `FRONTEND_ORIGIN`
   * above and for the mirror-image reason.
   */
  SERVICE_AUTH_TOKEN: z.string().default(''),

  /**
   * `tenant-service`'s internal seam, where a gateway's secrets are written
   * (F-102-c → F-102-a, D-31; moved out of `auth-service` by F-018-ab). Optional at boot on purpose: payments never use
   * it, so an unset value refuses only the gateway management writes, at call
   * time, rather than the whole service.
   */
  TENANT_API_BASE_URL: z.string().default(''),
  TENANT_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * `bot-service`'s internal seam, where a Mini App's invoice link is made
   * (F-104-q). Optional at boot like the one above: unset refuses only an
   * in-chat top-up started from a Mini App.
   */
  BOT_API_BASE_URL: z.string().default(''),
  BOT_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

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
  /**
   * How long the deposit callback waits on the gateway's verify, vault read
   * included, before it answers `verifying` and leaves the rest to the retry
   * ladder (F-092-ab, ADR-0046 decision 2). The driver's own attempts could
   * otherwise hold a payer's browser for ~47 s.
   */
  DEPOSIT_CALLBACK_VERIFY_BUDGET_MS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(8_000),
  ),
  PAYMENT_PENDING_TTL_SEC: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(900),
  ),

  /**
   * How many due payments one expiry sweep takes (F-092-k). The sweep is a
   * queue consumer's run, not a request: a bound exists so that a backlog
   * drains in bounded transactions rather than one long one, and the next tick
   * takes the next batch. Oldest first, so nothing is starved.
   */
  PAYMENT_EXPIRY_BATCH_SIZE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(200),
  ),

  /**
   * How many suspended Grants one purge sweep takes (F-027-y, ADR-0075). The
   * same argument as `PAYMENT_EXPIRY_BATCH_SIZE`: a backlog drains in bounded
   * transactions, oldest suspension first, and the next hourly tick takes the
   * next batch. The scan excludes Grants already purged, so it drains itself
   * rather than re-reading the same rows.
   */
  GRANT_PURGE_BATCH_SIZE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(200),
  ),

  /**
   * Delivery of a paid Grant (F-111-d, spec §5.8 step 3): it is checked once at
   * the first tick after payment, then retried this many times, the first retry
   * `GRANT_DELIVERY_FIRST_RETRY_MS` later and each one after at twice the last
   * wait. A Grant still undelivered after the last retry is cancelled and its
   * invoice refunded in full. The user's call (2026-09-25): 6 retries from one
   * minute — 1, 2, 4, 8, 16 and 32 minutes, about an hour — so a panel slow or
   * down for a few minutes refunds nobody, and nobody waits past the hour.
   */
  GRANT_DELIVERY_RETRIES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).default(6),
  ),
  GRANT_DELIVERY_FIRST_RETRY_MS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(60_000),
  ),

  /**
   * How long an expired top-up keeps its coupon holds before the sweep gives
   * them back (F-092-ah, ADR-0047 decision 2). The clock closes the payment,
   * not the coupon: a bank may still charge it, and a slot handed to someone
   * else meanwhile is how a late credit took a coupon past its limit. `0` is
   * the old behaviour — holds released with the payment.
   */
  COUPON_HOLD_AFTER_EXPIRY_SEC: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().nonnegative().default(3600),
  ),

  /**
   * Reconciliation (F-092-l): how many payments one run asks the gateway about,
   * how long an answer counts as recent, and how far back it looks at all.
   *
   * The recheck window is what stops the oldest unresolvable payment filling
   * every batch for ever — a payment asked about inside it is skipped — and the
   * lookback is the admission that a gateway's own records are not unbounded
   * either: past it, an unclaimed payment is an operator's question and not a
   * job's. Every run costs one gateway call per payment, so the batch is small.
   */
  RECONCILIATION_BATCH_SIZE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(50),
  ),
  RECONCILIATION_RECHECK_SEC: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(6 * 3600),
  ),
  RECONCILIATION_LOOKBACK_SEC: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(7 * 24 * 3600),
  ),
  /**
   * How long a payment may stay verifying — measured from when it was made —
   * before reconciliation flags it for a person (F-092-y, ADR-0044 decision 5).
   * The retries go on after it, hourly, to the lookback.
   */
  VERIFY_FLAG_AFTER_SEC: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(24 * 3600),
  ),

  /**
   * One callback origin for every tenant, instead of the tenant's own panel
   * domain (F-092-i). Development and test only: no tenant owns a host a
   * gateway's sandbox can reach, and `https://<domainValue>` would send the
   * browser nowhere. Unset in production, where ADR-0020 wants a reseller's
   * customer back on the brand they paid on.
   */
  PAYMENT_CALLBACK_ORIGIN: z.string().default(''),

  /**
   * The HMAC key the deposit callback signs its redirect with, shared with
   * `site-pwa`'s server and nothing else (`payment-result-token.ts`). The panel
   * shows a payment result only under a valid signature, so a hand-typed
   * `/payment/success?ref=…` shows nothing. Empty in development sends every
   * payer to the financial page instead; refused when NODE_ENV=production.
   */
  PAYMENT_RESULT_SECRET: z.string().default(''),

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
  /** Giving up a Mini App top-up before paying it (`payment/deposit/deposit-abandon.service.ts`). */
  DEPOSIT_ABANDON_RATE_LIMIT: rateLimit(30),
  /** Each call holds coupons for 30 minutes (`invoice/invoice.service.ts`, F-111-a). */
  INVOICE_CREATE_RATE_LIMIT: rateLimit(20),
  INVOICE_PAY_RATE_LIMIT: rateLimit(20),
  /** The shop cancels the invoice it replaces (`invoice/invoice.service.ts`, F-114-d): writes a status, holds nothing. */
  INVOICE_CANCEL_RATE_LIMIT: rateLimit(60),
  INVOICE_READ_RATE_LIMIT: rateLimit(120),
  SHOP_OFFERS_RATE_LIMIT: rateLimit(120),
  /** The bot's in-chat pre-checkout and paid relay, per payer (`payment/deposit/deposit-in-chat.controller.ts`). */
  DEPOSIT_IN_CHAT_RATE_LIMIT: rateLimit(120),
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
  // Per gateway per minute, public (F-104-b): one gateway's whole event stream.
  DEPOSIT_WEBHOOK_RATE_LIMIT: rateLimit(600),
  WALLET_HISTORY_RATE_LIMIT: rateLimit(180),
  WALLET_PAYMENTS_RATE_LIMIT: rateLimit(120),
  /** One payment, polled by the pending page every 10 s (F-093-l). */
  WALLET_PAYMENT_RATE_LIMIT: rateLimit(300),
  /** A code-guessing oracle if it were generous (`payment/gift/gift.controller.ts`). */
  GIFT_REDEEM_RATE_LIMIT: rateLimit(10),
  /** Every call throws a working key away (`payment/gift/grant-token.controller.ts`, F-502-p). */
  GRANT_ROTATE_TOKEN_RATE_LIMIT: rateLimit(5),
  /** The "my services" page, refetched on every visit (`payment/gift/grant-list.controller.ts`, F-502-r). */
  GRANT_LIST_RATE_LIMIT: rateLimit(120),
  /** Config lines pasted into the "my services" search (`payment/gift/grant-list.controller.ts`, F-307-p). */
  GRANTS_BY_LINES_RATE_LIMIT: rateLimit(60),
  /** Copy link / QR on the "my services" page (`payment/gift/subscription-link.service.ts`, F-114-e-b). */
  SUBSCRIPTION_LINK_RATE_LIMIT: rateLimit(60),
  /** Polled by the service page while metering is down (`traffic/collection-health.controller.ts`, F-027-w). */
  TRAFFIC_COLLECTION_HEALTH_RATE_LIMIT: rateLimit(180),
  /** A Grant's configs, opened on the service page (`traffic/user-configs.controller.ts`, F-027-ac). */
  CONFIG_LIST_RATE_LIMIT: rateLimit(180),
  /** One request is up to 50 configs, and each regenerate spends one of that config's three (F-027-ac). */
  CONFIG_ACTION_RATE_LIMIT: rateLimit(30),
  /** The 30-day usage chart, opened with a Grant's configs (`traffic/user-configs.controller.ts`, F-307-b). */
  GRANT_USAGE_RATE_LIMIT: rateLimit(180),
  /**
   * The operator settlement surface (`settlement/settlement.controller.ts`,
   * F-096-e), per operator. The read budget is the admin UI's refresh rate
   * while a transfer is being made; the write budget is far lower because a
   * grant, a withdrawal and a payout are each a deliberate human act, and
   * nobody records thirty payouts in a quarter of an hour.
   */
  SETTLEMENT_ADMIN_READ_RATE_LIMIT: rateLimit(120),
  SETTLEMENT_ADMIN_WRITE_RATE_LIMIT: rateLimit(30),
  /** Gateway management (`payment/gateway-admin/gateway-admin.controller.ts`, F-102-c), per user. */
  GATEWAY_ADMIN_READ_RATE_LIMIT: rateLimit(120),
  GATEWAY_ADMIN_WRITE_RATE_LIMIT: rateLimit(30),
  /** The systems surface (`systems/systems.controller.ts`, F-027-ar), per user. */
  SYSTEMS_ADMIN_WRITE_RATE_LIMIT: rateLimit(30),
  /** The systems page's reads (F-027-as), per user. Acknowledging a drift event shares the write budget. */
  SYSTEMS_ADMIN_READ_RATE_LIMIT: rateLimit(120),
  /** Manual payment confirmation (`payment/deposit/manual-confirm.controller.ts`, F-092-z), per user. */
  PAYMENT_MANUAL_READ_RATE_LIMIT: rateLimit(120),
  PAYMENT_MANUAL_WRITE_RATE_LIMIT: rateLimit(30),
  /** Coupon management (`payment/coupon-admin/coupon-admin.controller.ts`, F-502-f), per user. */
  COUPON_ADMIN_READ_RATE_LIMIT: rateLimit(120),
  COUPON_ADMIN_WRITE_RATE_LIMIT: rateLimit(30),
  /** Catalog management (`catalog/catalog-admin.controller.ts`, F-026-d), per user. */
  RESELLER_REVENUE_READ_RATE_LIMIT: rateLimit(120),
  CATALOG_ADMIN_READ_RATE_LIMIT: rateLimit(120),
  CATALOG_ADMIN_WRITE_RATE_LIMIT: rateLimit(30),
  /** Manual billing-wallet adjustment (`tenant-billing/tenant-billing-admin.controller.ts`, F-019-a), per user. */
  TENANT_BILLING_ADMIN_WRITE_RATE_LIMIT: rateLimit(30),
}).refine((env) => !(env.NODE_ENV === 'production' && env.PAYMENT_GATEWAY_SANDBOX), {
  message: 'PAYMENT_GATEWAY_SANDBOX=true is refused when NODE_ENV=production',
  path: ['PAYMENT_GATEWAY_SANDBOX'],
}).refine((env) => !(env.NODE_ENV === 'production' && !env.SERVICE_AUTH_TOKEN), {
  message: 'SERVICE_AUTH_TOKEN is required when NODE_ENV=production: without it every internal call is refused and the expiry sweep never runs',
  path: ['SERVICE_AUTH_TOKEN'],
}).refine((env) => !(env.NODE_ENV === 'production' && env.PAYMENT_RESULT_SECRET.length < 32), {
  message: 'PAYMENT_RESULT_SECRET (32+ characters) is required when NODE_ENV=production: without it no payment result can be shown',
  path: ['PAYMENT_RESULT_SECRET'],
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
