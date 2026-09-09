import { ConfigService } from '@nestjs/config';
import { BotClientRegistry } from './bot-client.registry';
import { BotIntegration, BotIntegrationDirectory } from './bot-integration';
import { aBotIntegration } from './bot-integration.fixture';
import { DEEP_LINK_BASE } from './deep-link';

/**
 * The registry is where a `BotIntegration` becomes a driver, and every caller
 * downstream asks it one of two questions: "can this bot send?" and "give me
 * the thing that sends". Since F-066-i the answer comes from a tenant's row
 * and the Credential Vault rather than from the environment, and three of its
 * properties are load-bearing without being visible at any call site:
 *
 *   - `client()` returning null is how a bot with no usable token stops being
 *     offered at all, rather than being offered and failing at send time;
 *   - it never caches a client, because a cached client is a decrypted token
 *     held for an unbounded time with no audit row saying it was held
 *     (ADR-0026 decision 5). A rotation or a revocation has to take effect on
 *     the next send, not on the next boot;
 *   - the questions that are asked constantly — can this channel send, can it
 *     link — must not decrypt, or the audit trail records *someone asked*
 *     instead of *someone held the value*.
 *
 * What is still environment is what belongs to a *platform* and not to a
 * tenant: the API host and the deep-link host.
 */

function config(env: Record<string, string | number> = {}) {
  return {
    get: <T>(key: string, fallback?: T) => (env[key] as unknown as T) ?? fallback,
  } as unknown as ConfigService;
}

const telegram = aBotIntegration();
const bale = aBotIntegration({
  id: 'i-bale',
  platform: 'bale',
  botUsername: 'txnet_bale_bot',
});

/**
 * A directory holding one token per integration id. `null` is "no usable
 * token" — the missing, revoked and expired cases collapse into one answer
 * here on purpose, because they are one answer to every caller.
 */
function directory(
  tokens: Record<string, string | null> = {
    [telegram.id]: 'tg-token',
    [bale.id]: 'bale-token',
  },
) {
  return {
    byWebhookPath: jest.fn(async () => null),
    primaryFor: jest.fn(async (tenantId: string, platform: string) =>
      platform === 'telegram' && tenantId === telegram.tenantId
        ? telegram
        : platform === 'bale' && tenantId === bale.tenantId
          ? bale
          : null,
    ),
    token: jest.fn(async (i: BotIntegration) => tokens[i.id] ?? null),
    hasToken: jest.fn(async (i: BotIntegration) => tokens[i.id] != null),
    verifyWebhookSecret: jest.fn(async (_i: BotIntegration, c: string) =>
      c === 'the-secret',
    ),
  } satisfies BotIntegrationDirectory & Record<string, unknown>;
}

function registry(env = {}, dir = directory()) {
  return { r: new BotClientRegistry(config(env), dir), dir };
}

describe('BotClientRegistry', () => {
  it('builds a client for an integration whose token is usable', async () => {
    const { r } = registry();

    await expect(r.client(telegram, 'test')).resolves.not.toBeNull();
    await expect(r.client(bale, 'test')).resolves.not.toBeNull();
  });

  it('reports an integration with no usable token as having no client', async () => {
    // Not an empty client, not a throwing one: null, so a caller cannot use it
    // by accident.
    const { r } = registry({}, directory({ [telegram.id]: null }));

    await expect(r.client(telegram, 'test')).resolves.toBeNull();
  });

  it('resolves the token again on every send, and never caches a client', async () => {
    // The property this protects is a rotation taking effect now. A cached
    // client would also skip the audit row `use()` writes.
    const { r, dir } = registry();

    const first = await r.client(telegram, 'test');
    const second = await r.client(telegram, 'test');

    expect(dir.token).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it('names the caller it was given, so the audit row says who sent', async () => {
    const { r, dir } = registry();

    await r.client(telegram, 'identity:TelegramOtpSender');

    expect(dir.token).toHaveBeenCalledWith(
      telegram,
      'identity:TelegramOtpSender',
    );
  });

  describe('the questions asked on every request', () => {
    it('answers canSend without decrypting anything', async () => {
      const { r, dir } = registry();

      await expect(r.canSend(telegram.tenantId, 'telegram')).resolves.toBe(true);

      expect(dir.hasToken).toHaveBeenCalled();
      expect(dir.token).not.toHaveBeenCalled();
    });

    it('answers canLink without decrypting anything', async () => {
      const { r, dir } = registry();

      await expect(r.canLink(telegram.tenantId, 'telegram')).resolves.toBe(true);

      expect(dir.token).not.toHaveBeenCalled();
    });

    it('says a tenant with no integration cannot send', async () => {
      const { r } = registry();

      await expect(r.canSend('some-other-tenant', 'telegram')).resolves.toBe(
        false,
      );
    });

    it('refuses to link a bot with no username, even with a token', async () => {
      // A link flow needs a deep link, and there is no deep link without the
      // username. Offering one that cannot complete is worse than offering
      // none.
      const nameless = aBotIntegration({ botUsername: '' });
      const dir = directory({ [nameless.id]: 'tg-token' });
      dir.primaryFor = jest.fn(async (_t: string, _p: string) => nameless);
      const { r } = registry({}, dir);

      await expect(r.canLink(nameless.tenantId, 'telegram')).resolves.toBe(
        false,
      );
    });
  });

  describe('the webhook secret', () => {
    it('is verified against the integration, not against the environment', async () => {
      const { r, dir } = registry();

      await expect(r.verifyWebhookSecret(telegram, 'the-secret')).resolves.toBe(
        true,
      );
      await expect(r.verifyWebhookSecret(telegram, 'nope')).resolves.toBe(false);
      expect(dir.verifyWebhookSecret).toHaveBeenCalledWith(telegram, 'nope');
    });
  });

  describe('deepLink', () => {
    it('uses each platform’s own host and the bot’s own username', () => {
      const { r } = registry();

      expect(r.deepLink(telegram, 'tok-1')).toBe(
        `${DEEP_LINK_BASE.telegram}/txnet_bot?start=tok-1`,
      );
      expect(r.deepLink(bale, 'tok-1')).toBe(
        `${DEEP_LINK_BASE.bale}/txnet_bale_bot?start=tok-1`,
      );
    });

    it('honours an overridden base, trailing slash and all', () => {
      const { r } = registry({ TELEGRAM_DEEP_LINK_BASE: 'https://t.me/s/' });

      expect(r.deepLink(telegram, 'tok-1')).toBe(
        'https://t.me/s/txnet_bot?start=tok-1',
      );
    });

    it('encodes the payload', () => {
      const { r } = registry();

      expect(r.deepLink(telegram, 'a b&c')).toContain('start=a%20b%26c');
    });

    it('returns null without a username rather than a broken link', () => {
      // A link to `https://t.me/undefined?start=…` looks like a link and is
      // not one; the caller has to be able to tell.
      const { r } = registry();

      expect(r.deepLink(aBotIntegration({ botUsername: '' }), 'tok-1')).toBeNull();
    });
  });

  it('reports capabilities for a platform whether or not a bot exists', () => {
    // Capabilities are a property of the messenger, not of any tenant's row:
    // the answer must not depend on whether a token happens to be set.
    const { r } = registry();
    const { r: bare } = registry({}, directory({}));

    expect(bare.capabilities('telegram')).toEqual(r.capabilities('telegram'));
  });

  describe('verifyWebAppInitData', () => {
    it('is malformed for an integration with no usable token', async () => {
      // An unconfigured bot cannot have signed anything, so the answer is that
      // the data is malformed rather than that the signature was wrong.
      const { r } = registry({}, directory({ [telegram.id]: null }));

      await expect(
        r.verifyWebAppInitData(telegram, 'auth_date=1&hash=abc'),
      ).resolves.toEqual({ ok: false, reason: 'malformed' });
    });
  });
});
