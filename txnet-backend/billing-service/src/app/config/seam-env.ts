import { z } from 'zod';

const baseUrl = z.string().default('');
const timeoutMs = (ms: number) => z.coerce.number().int().positive().default(ms);

/**
 * The other services' internal seams this service calls, each a base URL and
 * a call timeout. All optional at boot on purpose: an unset one refuses only
 * the work that uses it, at call time, rather than the whole service.
 */
export const seamEnv = {
  /**
   * `tenant-service`: a gateway's secrets are written there (F-102-c → F-102-a,
   * D-31; moved out of `auth-service` by F-018-ab), a panel's login (F-027-ar),
   * and an import's source login is destroyed there (F-201-d).
   */
  TENANT_API_BASE_URL: baseUrl,
  TENANT_API_TIMEOUT_MS: timeoutMs(10_000),
  /** `bot-service`: a Mini App's invoice link is made there (F-104-q). */
  BOT_API_BASE_URL: baseUrl,
  BOT_API_TIMEOUT_MS: timeoutMs(10_000),
  /**
   * `network-service`: an import reads its source panel there (F-201-b,
   * F-206). A snapshot may take up to 2 minutes (network's own deadline), so
   * the default waits a little longer.
   */
  NETWORK_API_BASE_URL: baseUrl,
  NETWORK_API_TIMEOUT_MS: timeoutMs(150_000),
  /** `auth-service`: an import's people are found or made there (F-201-e, F-207). */
  AUTH_API_BASE_URL: baseUrl,
  AUTH_API_TIMEOUT_MS: timeoutMs(30_000),
};
