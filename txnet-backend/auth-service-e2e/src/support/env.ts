/**
 * The environment `auth-service` boots against in the e2e run.
 *
 * Set before anything imports `AppModule`: `ConfigModule.forRoot({ validate })`
 * reads `process.env` at import time, and a value already there wins over the
 * workspace `.env` file, so the run is not at the mercy of a developer's
 * local settings.
 *
 * Two deliberate choices, both of which the tests depend on:
 *   OTP_DELIVERY_MODE=console  — nothing is really sent; the code is printed,
 *                                which is how a test learns it (see otp.ts).
 *   OTP_ALLOWED_CHANNELS=sms   — the only channel that does not need a linked
 *                                messenger, so every OTP flow stays on the
 *                                "a code was sent" branch. The `linkRequired`
 *                                branch belongs to the bot-link specs.
 */
import { readInfraFile } from './infra';

/**
 * A deployment, as this suite understands one: the handful of values that a
 * white-label install actually varies. They were literals in `applyE2eEnv`
 * below, which made every cookie-domain, CORS and default-language assertion
 * a statement about `txnet.test` rather than about *the configured
 * deployment* — one fixed install round-tripping, which is not the same
 * claim (backlog F-059).
 *
 * Note the honest limit, recorded here because it is exactly where a reader
 * will look for it: `auth-service` has no request -> tenant resolution yet.
 * `RegisterService` writes every account to the `platform_owner` tenant
 * (`register.service.ts`), so what this file parameterizes is the
 * *deployment*, not one of several tenants served by one process. Proving
 * the latter needs the resolution feature to exist first — see the backlog.
 */
export interface Deployment {
  /** `DOMAIN_NAME` — the refresh cookie's domain is derived from it. */
  domain: string;
  /** `FRONTEND_ORIGIN` — the only origin CORS lets through. */
  frontendOrigin: string;
  /** `DEFAULT_LANGUAGE` — what an unlabelled request is answered in. */
  defaultLanguage: string;
}

export const PRIMARY_DEPLOYMENT: Deployment = {
  domain: 'txnet.test',
  frontendOrigin: 'http://localhost:4200',
  defaultLanguage: 'fa',
};

/**
 * A second install with nothing in common with the first — different domain,
 * different panel origin, different language. Every value the suite asserts
 * has to move when this one is booted instead, or it was a constant.
 */
export const SECONDARY_DEPLOYMENT: Deployment = {
  domain: 'reseller.test',
  frontendOrigin: 'http://localhost:4300',
  defaultLanguage: 'en',
};

/** The cookie domain a deployment produces — `.` + its domain. */
export const cookieDomainOf = (deployment: Deployment) =>
  `.${deployment.domain}`;

/** The deployment the current process is configured for. */
let active: Deployment = PRIMARY_DEPLOYMENT;

export const activeDeployment = (): Deployment => active;

/**
 * The values the specs assert against, next to the environment that produces
 * them. A spec that types `900` or `'refresh_token'` by hand pins the value in
 * a second place, and the service can then change it while the suite stays
 * green — see `COOKIE_DOMAIN` below, which has always worked this way.
 */

/** `JWT_ACCESS_TTL_SEC` below — the `expiresIn` every token response carries. */
export const ACCESS_TTL_SEC = 900;

/** The refresh cookie's name — `auth-service`'s `common/http/refresh-cookie.ts`. */
export const REFRESH_COOKIE = 'refresh_token';

/** That cookie's `Max-Age`, in seconds (the service sets it in ms). */
export const REFRESH_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export function applyE2eEnv(
  deployment: Deployment = PRIMARY_DEPLOYMENT,
): void {
  const { databaseUrl, redisUrl } = readInfraFile();
  active = deployment;

  const env: Record<string, string> = {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    REDIS_KEY_NAMESPACE: 'txnet:auth',
    REDIS_KEYSPACE_VERSION: 'e2e',
    DOMAIN_NAME: deployment.domain,
    COOKIE_SECURE: 'false',
    FRONTEND_ORIGIN: deployment.frontendOrigin,
    TRUST_PROXY: '1',
    JWT_ACCESS_SECRET: 'e2e-access-secret-e2e-access-secret',
    JWT_REFRESH_HASH_SECRET: 'e2e-refresh-secret-e2e-refresh-secret',
    JWT_ACCESS_TTL_SEC: String(ACCESS_TTL_SEC),
    OTP_TOKEN_TTL_SEC: '300',
    RESET_TOKEN_TTL_SEC: '300',
    OTP_ALLOWED_CHANNELS: 'sms',
    OTP_DELIVERY_MODE: 'console',
    OTP_DEV_CONSOLE_LOG: 'false',
    // No bot is configured and none may be contacted: registration on boot
    // would be an outbound call to Telegram/Bale from a test run.
    BOT_WEBHOOK_AUTO_REGISTER: 'false',
    TELEGRAM_BOT_TOKEN: '',
    BALE_BOT_TOKEN: '',
    TELEGRAM_WEBHOOK_SECRET: '',
    BALE_WEBHOOK_SECRET: '',
    LOCALE_SERVICE_ADDR: 'unused.invalid:50051',
    DEFAULT_LANGUAGE: deployment.defaultLanguage,
  };

  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

/**
 * The cookie domain the service is configured with, asserted by the specs.
 * Derived from whichever deployment `applyE2eEnv` was given, so a spec that
 * imports it keeps asserting the right thing when the deployment changes.
 */
export const COOKIE_DOMAIN = cookieDomainOf(PRIMARY_DEPLOYMENT);
