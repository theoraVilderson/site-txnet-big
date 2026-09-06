import { ConfigService } from '@nestjs/config';
import { BotClientRegistry } from './bot-client.registry';
import { DEEP_LINK_BASE } from './deep-link';

/**
 * The registry is where environment variables become a bot, and every caller
 * downstream asks it one question: "is this platform usable?" Two of its
 * answers are load-bearing and neither is obvious from the call site:
 *
 *   - `client()` returning null is how an unconfigured channel stops being
 *     offered at all, rather than being offered and then failing at send time;
 *   - `canLink()` is deliberately stricter than `client()`. Delivering a code
 *     needs only a token; *linking* also needs the username (there is no deep
 *     link without it) and the webhook secret (nothing would come back).
 *     Conflating the two offers a link flow that cannot complete.
 */

function config(env: Record<string, string | number> = {}) {
  return {
    get: <T>(key: string, fallback?: T) => (env[key] as unknown as T) ?? fallback,
  } as unknown as ConfigService;
}

const fullyConfigured = {
  TELEGRAM_BOT_TOKEN: 'tg-token',
  TELEGRAM_BOT_USERNAME: 'txnet_bot',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
  BALE_BOT_TOKEN: 'bale-token',
  BALE_BOT_USERNAME: 'txnet_bale_bot',
  BALE_WEBHOOK_SECRET: 'bale-secret',
};

describe('BotClientRegistry', () => {
  it('builds a client for each platform that has a token', () => {
    const registry = new BotClientRegistry(config(fullyConfigured));

    expect(registry.client('telegram')).not.toBeNull();
    expect(registry.client('bale')).not.toBeNull();
  });

  it('reports an unconfigured platform as having no client at all', () => {
    // Not an empty client, not a throwing one: null, so a caller cannot use
    // it by accident.
    const registry = new BotClientRegistry(config({ TELEGRAM_BOT_TOKEN: 'tg-token' }));

    expect(registry.client('telegram')).not.toBeNull();
    expect(registry.client('bale')).toBeNull();
  });

  it('keeps the two platforms independent', () => {
    const registry = new BotClientRegistry(config(fullyConfigured));

    expect(registry.client('telegram')).not.toBe(registry.client('bale'));
    expect(registry.username('telegram')).toBe('txnet_bot');
    expect(registry.username('bale')).toBe('txnet_bale_bot');
    expect(registry.webhookSecret('telegram')).toBe('tg-secret');
    expect(registry.webhookSecret('bale')).toBe('bale-secret');
  });

  it('strips a trailing slash off the API base', () => {
    // `…//bot<token>/…` is answered with a 404 by some API hosts, and the
    // symptom is a bot that silently never sends.
    const registry = new BotClientRegistry(
      config({ ...fullyConfigured, TELEGRAM_API_BASE: 'https://api.telegram.org///' }),
    );

    const client = registry.client('telegram') as unknown as { apiBase: string };
    expect(client.apiBase).toBe('https://api.telegram.org');
  });

  describe('canLink is stricter than client', () => {
    it('is true only with a token, a username and a webhook secret', () => {
      const registry = new BotClientRegistry(config(fullyConfigured));
      expect(registry.canLink('telegram')).toBe(true);
      expect(registry.canLink('bale')).toBe(true);
    });

    it.each([
      ['no token', { TELEGRAM_BOT_TOKEN: '' }],
      ['no username', { TELEGRAM_BOT_USERNAME: '' }],
      ['no webhook secret', { TELEGRAM_WEBHOOK_SECRET: '' }],
    ])('is false with %s', (_name, missing) => {
      const registry = new BotClientRegistry(config({ ...fullyConfigured, ...missing }));
      expect(registry.canLink('telegram')).toBe(false);
    });

    it('is false for linking while the channel still delivers codes', () => {
      // A token but no username: OTP over this platform works, the link flow
      // cannot start. Both answers have to be available separately.
      const registry = new BotClientRegistry(
        config({ TELEGRAM_BOT_TOKEN: 'tg-token', TELEGRAM_WEBHOOK_SECRET: 's' }),
      );

      expect(registry.client('telegram')).not.toBeNull();
      expect(registry.canLink('telegram')).toBe(false);
    });
  });

  describe('deepLink', () => {
    it('uses each platform’s own host', () => {
      const registry = new BotClientRegistry(config(fullyConfigured));

      expect(registry.deepLink('telegram', 'tok-1')).toBe(
        `${DEEP_LINK_BASE.telegram}/txnet_bot?start=tok-1`,
      );
      expect(registry.deepLink('bale', 'tok-1')).toBe(
        `${DEEP_LINK_BASE.bale}/txnet_bale_bot?start=tok-1`,
      );
    });

    it('honours an overridden base, trailing slash and all', () => {
      const registry = new BotClientRegistry(
        config({ ...fullyConfigured, TELEGRAM_DEEP_LINK_BASE: 'https://t.me/s/' }),
      );

      expect(registry.deepLink('telegram', 'tok-1')).toBe('https://t.me/s/txnet_bot?start=tok-1');
    });

    it('encodes the payload', () => {
      const registry = new BotClientRegistry(config(fullyConfigured));

      expect(registry.deepLink('telegram', 'a b&c')).toContain('start=a%20b%26c');
    });

    it('returns null without a username rather than a broken link', () => {
      // A link to `https://t.me/undefined?start=…` looks like a link and is
      // not one; the caller has to be able to tell.
      const registry = new BotClientRegistry(config({ TELEGRAM_BOT_TOKEN: 'tg-token' }));

      expect(registry.deepLink('telegram', 'tok-1')).toBeNull();
    });
  });

  it('reports capabilities for a platform that is not configured', () => {
    // Capabilities are a property of the messenger, not of this deployment's
    // env: the answer must not depend on whether a token happens to be set.
    const configured = new BotClientRegistry(config(fullyConfigured));
    const bare = new BotClientRegistry(config());

    expect(bare.capabilities('telegram')).toEqual(configured.capabilities('telegram'));
    expect(bare.capabilities('bale')).toEqual(configured.capabilities('bale'));
  });
});
