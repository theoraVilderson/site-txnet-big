import { randomBytes } from 'node:crypto';
import { BotIntegration } from './bot-integration';
import { BotPlatform } from './bot-platform';

/**
 * Where a bot's updates arrive, and how that address is minted (catalog 10.2).
 *
 * The address is one string — `webhookPath` — and it is a credential, not a
 * name: resolving it is what yields the tenant and the platform, so anything
 * that builds or rebuilds it belongs to this unit rather than to whichever
 * process happens to be registering at the time. Two of them are: `bot-service`
 * points every bot at its own door on boot (F-321), and `auth-service` rotates
 * a path that has to die (F-322). If those two built the URL separately they
 * would eventually build it differently, and the symptom would be a bot that
 * re-registers itself away from the running service on every restart.
 */

/**
 * 32 bytes, per catalog 10.2 — the whole reason an unknown path can answer 404
 * without leaking that some other path would not.
 */
export const WEBHOOK_PATH_BYTES = 32;

/**
 * A fresh, unguessable webhook path.
 *
 * Hex rather than base64url: the value travels in a URL, in a Traefik rule and
 * in a `setWebhook` call, and one of those three eventually mangles a `-` or a
 * `_`. 64 hex characters is the same 32 bytes of entropy either way.
 */
export function newWebhookPath(): string {
  return randomBytes(WEBHOOK_PATH_BYTES).toString('hex');
}

/** The exact path `bot-service`'s `WebhookController` serves, under `/api`. */
export function webhookUrl(
  base: string,
  integration: Pick<BotIntegration, 'platform' | 'webhookPath'>,
): string {
  return `${base.replace(/\/+$/, '')}/api/bots/${integration.platform}/${
    integration.webhookPath
  }`;
}

/**
 * A webhook URL with its credential half replaced by `***`.
 *
 * Every log line about a registration wants to name the bot and the door
 * without writing the door down, and a caller that has to remember to redact
 * is a caller that will forget once.
 */
export function redactedWebhookUrl(
  base: string,
  platform: BotPlatform,
): string {
  return `${base.replace(/\/+$/, '')}/api/bots/${platform}/***`;
}

/**
 * Where *this* platform reaches the service serving the webhook, most specific
 * first:
 *
 * 1. `<PLATFORM>_WEBHOOK_PUBLIC_BASE` — one platform needs a different way in
 *    than the others. Telegram, for instance, cannot open a connection to
 *    every host on the internet, so its updates come back through a proxy
 *    while Bale calls the API directly.
 * 2. `BOT_WEBHOOK_PUBLIC_BASE` — every platform goes through the same front
 *    door: a dev tunnel, or another app fronting this API.
 * 3. `https://api.<DOMAIN_NAME>` — the convention the Traefik router already
 *    assumes.
 *
 * Per platform and not per tenant: this is where the *platform* is reachable,
 * which is the same address whoever the bot belongs to. A tenant's own domain
 * is its panel, not its webhook.
 *
 * `get` is a plain lookup rather than a `ConfigService`, so the two processes
 * that answer this question can share the answer without sharing a module.
 */
export function resolveWebhookBase(
  get: (key: string) => string | undefined,
  platform: BotPlatform,
): string | null {
  const perPlatform = get(`${platform.toUpperCase()}_WEBHOOK_PUBLIC_BASE`);
  const shared = get('BOT_WEBHOOK_PUBLIC_BASE');
  const domain = get('DOMAIN_NAME');
  const base = perPlatform || shared || (domain ? `https://api.${domain}` : null);
  return base ? base.replace(/\/+$/, '') : null;
}
