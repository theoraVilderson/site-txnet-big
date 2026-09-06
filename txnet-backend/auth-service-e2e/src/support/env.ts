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

export function applyE2eEnv(): void {
  const { databaseUrl, redisUrl } = readInfraFile();

  const env: Record<string, string> = {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    REDIS_KEY_NAMESPACE: 'txnet:auth',
    REDIS_KEYSPACE_VERSION: 'e2e',
    DOMAIN_NAME: 'txnet.test',
    COOKIE_SECURE: 'false',
    FRONTEND_ORIGIN: 'http://localhost:4200',
    TRUST_PROXY: '1',
    JWT_ACCESS_SECRET: 'e2e-access-secret-e2e-access-secret',
    JWT_REFRESH_HASH_SECRET: 'e2e-refresh-secret-e2e-refresh-secret',
    JWT_ACCESS_TTL_SEC: '900',
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
    DEFAULT_LANGUAGE: 'fa',
  };

  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

/** The cookie domain the service is configured with, asserted by the specs. */
export const COOKIE_DOMAIN = '.txnet.test';
