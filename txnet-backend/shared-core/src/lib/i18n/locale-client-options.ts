import type { LocaleClientConfig } from '@txnet/locale-client';
import { z } from 'zod';

/** How long a boot waits for locale-service before it falls back to disk or fails — it may still be starting. */
const LOCALE_BOOT_TIMEOUT_MS = 60_000;

/**
 * The locale client's three keys, spread into every Node service's `envSchema`
 * (C-26) — one home instead of eight copies (C-27).
 */
export const localeEnv = {
  /** locale-service's gRPC address. */
  LOCALE_SERVICE_ADDR: z.string().min(1).default('localhost:50051'),
  /** The scope a backend service reads. */
  LOCALE_SCOPE: z.string().min(1).default('backend'),
  /** Where every snapshot is saved and a boot falls back to while locale-service is down (hosting H17). */
  LOCALE_CACHE_DIR: z.string().min(1).default('/var/cache/txnet-locale'),
};

/** A validated config holding `localeEnv` — each app's `ConfigService`. */
export interface LocaleConfig {
  get(key: keyof typeof localeEnv): unknown;
}

/** The three lines of a Nest `Logger` the client writes through. */
type LocaleLogger = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * Every Node service's `createLocaleClient` options, from its validated config:
 * where locale-service and the disk cache are (H17), the boot budget, and the
 * service's own logger.
 */
export function localeClientOptions(config: LocaleConfig, logger: LocaleLogger, defaultLang: string): LocaleClientConfig {
  return {
    addr: String(config.get('LOCALE_SERVICE_ADDR')),
    scope: String(config.get('LOCALE_SCOPE')),
    cacheDir: String(config.get('LOCALE_CACHE_DIR')),
    defaultLang,
    bootTimeoutMs: LOCALE_BOOT_TIMEOUT_MS,
    logger: { log: (m) => logger.log(m), warn: (m) => logger.warn(m), error: (m) => logger.error(m) },
  };
}
