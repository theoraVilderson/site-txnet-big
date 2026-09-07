import { ConfigService } from '@nestjs/config';
import {
  BOT_PLATFORMS,
  BotClientRegistry,
  BotPlatform,
  TelegramLikeBotClient,
  WebhookInfo,
} from '@txnet-backend/messenger';
import { BotCopy } from '../locale/bot-copy';
import { BotWebhookRegistrar } from './bot-webhook.registrar';

/**
 * Boot-time webhook registration. Every failure mode here is silent — a bot
 * that answers nothing, or one that answers messages and drops every button
 * tap — so the cases worth a test are the ones a green service still gets
 * wrong:
 *
 *   - the URL it points the platform at, including which base wins;
 *   - the two cases where it must *not* write: an unreadable current webhook,
 *     and one that is already correct;
 *   - the one case where a correct-looking URL must still be rewritten, which
 *     the class doc calls out as never healing on its own;
 *   - a platform that is not configured must not take the other one with it.
 *
 * `TelegramLikeBotClient.deliversEveryUpdate` has its own tests in
 * `telegram-like-bot.client.spec.ts`; this spec only exercises the registrar's
 * use of it.
 */

const SECRETS: Record<BotPlatform, string | undefined> = {
  telegram: 'tg-secret',
  bale: 'bale-secret',
};

type FakeClient = {
  getWebhookInfo: jest.Mock<Promise<WebhookInfo | null>, []>;
  setWebhook: jest.Mock<Promise<boolean>, [string, string]>;
  setMyCommands: jest.Mock<Promise<boolean>, [unknown, string?]>;
};

/** A webhook already registered at `url`, delivering everything by default. */
function info(url: string, allowedUpdates: string[] = []): WebhookInfo {
  return { url, allowedUpdates };
}

function fakeClient(current: WebhookInfo | null = info('')): FakeClient {
  return {
    getWebhookInfo: jest.fn(async () => current),
    setWebhook: jest.fn(async (_url: string, _secret: string) => true),
    setMyCommands: jest.fn(async (_list: unknown, _lang?: string) => true),
  };
}

function build({
  env = {} as Record<string, string>,
  clients = {} as Partial<Record<BotPlatform, FakeClient | null>>,
  secrets = SECRETS,
}: {
  env?: Record<string, string>;
  clients?: Partial<Record<BotPlatform, FakeClient | null>>;
  secrets?: Record<BotPlatform, string | undefined>;
} = {}) {
  const values = new Map(Object.entries(env));
  const config = {
    get: (key: string, fallback?: string) => values.get(key) ?? fallback,
  } as unknown as ConfigService;

  const resolved = Object.fromEntries(
    BOT_PLATFORMS.map((p) => [
      p,
      p in clients ? (clients[p] ?? null) : fakeClient(),
    ]),
  ) as Record<BotPlatform, FakeClient | null>;

  const bots = {
    client: jest.fn((p: BotPlatform) => resolved[p]),
    webhookSecret: jest.fn((p: BotPlatform) => secrets[p]),
  } as unknown as BotClientRegistry;

  // The language argument is what a wrong command menu turns on, so make it
  // visible in the assertion instead of translating anything.
  const copy = {
    text: (lang: string, text: { key?: string }) => `${lang}:${text.key}`,
  } as unknown as BotCopy;

  return {
    registrar: new BotWebhookRegistrar(config, bots, copy),
    clients: resolved,
  };
}

/** What the registrar should have pointed `platform` at. */
function expectedUrl(base: string, platform: BotPlatform): string {
  return `${base}/api/bot/${platform}/webhook/${SECRETS[platform]}`;
}

describe('BotWebhookRegistrar', () => {
  describe('the URL it registers', () => {
    it('derives it from DOMAIN_NAME when nothing more specific is set', async () => {
      const { registrar, clients } = build({ env: { DOMAIN_NAME: 'txnet.io' } });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).toHaveBeenCalledWith(
        expectedUrl('https://api.txnet.io', 'telegram'),
        SECRETS.telegram,
      );
      expect(clients.bale?.setWebhook).toHaveBeenCalledWith(
        expectedUrl('https://api.txnet.io', 'bale'),
        SECRETS.bale,
      );
    });

    it('prefers the shared base over DOMAIN_NAME', async () => {
      const { registrar, clients } = build({
        env: {
          DOMAIN_NAME: 'txnet.io',
          BOT_WEBHOOK_PUBLIC_BASE: 'https://tunnel.example',
        },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).toHaveBeenCalledWith(
        expectedUrl('https://tunnel.example', 'telegram'),
        SECRETS.telegram,
      );
    });

    it('lets one platform have its own base without moving the others', async () => {
      const { registrar, clients } = build({
        env: {
          DOMAIN_NAME: 'txnet.io',
          BOT_WEBHOOK_PUBLIC_BASE: 'https://tunnel.example',
          TELEGRAM_WEBHOOK_PUBLIC_BASE: 'https://proxy.example',
        },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).toHaveBeenCalledWith(
        expectedUrl('https://proxy.example', 'telegram'),
        SECRETS.telegram,
      );
      expect(clients.bale?.setWebhook).toHaveBeenCalledWith(
        expectedUrl('https://tunnel.example', 'bale'),
        SECRETS.bale,
      );
    });

    it('does not produce a // when the base is written with a trailing slash', async () => {
      const { registrar, clients } = build({
        env: { BOT_WEBHOOK_PUBLIC_BASE: 'https://tunnel.example//' },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).toHaveBeenCalledWith(
        expectedUrl('https://tunnel.example', 'telegram'),
        SECRETS.telegram,
      );
    });

    it('registers nothing when there is no base to build one from', async () => {
      const { registrar, clients } = build();

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).not.toHaveBeenCalled();
      expect(clients.bale?.setWebhook).not.toHaveBeenCalled();
    });
  });

  describe('when it must not write', () => {
    it('leaves a webhook it could not read alone', async () => {
      const { registrar, clients } = build({
        env: { DOMAIN_NAME: 'txnet.io' },
        clients: { telegram: fakeClient(null) },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).not.toHaveBeenCalled();
      // A platform that could not be asked must not stop the other one.
      expect(clients.bale?.setWebhook).toHaveBeenCalled();
    });

    it('leaves a correct registration that already delivers everything', async () => {
      const url = expectedUrl('https://api.txnet.io', 'telegram');
      const { registrar, clients } = build({
        env: { DOMAIN_NAME: 'txnet.io' },
        clients: { telegram: fakeClient(info(url)) },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).not.toHaveBeenCalled();
    });

    it('touches nothing at all when auto-registration is off', async () => {
      const { registrar, clients } = build({
        env: { DOMAIN_NAME: 'txnet.io', BOT_WEBHOOK_AUTO_REGISTER: 'false' },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.getWebhookInfo).not.toHaveBeenCalled();
      expect(clients.telegram?.setWebhook).not.toHaveBeenCalled();
      expect(clients.telegram?.setMyCommands).not.toHaveBeenCalled();
    });
  });

  describe('when it must write anyway', () => {
    it('rewrites a correct URL that was registered for too few update types', async () => {
      const url = expectedUrl('https://api.txnet.io', 'telegram');
      const narrow = info(url, ['message']);
      expect(TelegramLikeBotClient.deliversEveryUpdate(narrow.allowedUpdates)).toBe(
        false,
      );
      const { registrar, clients } = build({
        env: { DOMAIN_NAME: 'txnet.io' },
        clients: { telegram: fakeClient(narrow) },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).toHaveBeenCalledWith(
        url,
        SECRETS.telegram,
      );
    });

    it('replaces a webhook pointing somewhere else', async () => {
      const { registrar, clients } = build({
        env: { DOMAIN_NAME: 'txnet.io' },
        clients: { telegram: fakeClient(info('https://old.example/hook')) },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).toHaveBeenCalledWith(
        expectedUrl('https://api.txnet.io', 'telegram'),
        SECRETS.telegram,
      );
    });
  });

  describe('a platform that is not configured', () => {
    it('is skipped without stopping the other one', async () => {
      const { registrar, clients } = build({
        env: { DOMAIN_NAME: 'txnet.io' },
        clients: { telegram: null },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.bale?.setWebhook).toHaveBeenCalled();
    });

    it('is skipped when it has a client but no webhook secret', async () => {
      const { registrar, clients } = build({
        env: { DOMAIN_NAME: 'txnet.io' },
        secrets: { ...SECRETS, telegram: undefined },
      });

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setWebhook).not.toHaveBeenCalled();
      expect(clients.bale?.setWebhook).toHaveBeenCalled();
    });
  });

  describe('the command menu', () => {
    it('is published unlabelled for the fallback language, then once per language', async () => {
      const { registrar, clients } = build({
        env: {
          DOMAIN_NAME: 'txnet.io',
          DEFAULT_LANGUAGE: 'fa',
          BOT_COMMAND_LANGS: 'fa, en ,ar',
        },
      });

      await registrar.onApplicationBootstrap();

      const calls = clients.telegram?.setMyCommands.mock.calls ?? [];
      expect(calls.map((c) => c[1])).toEqual([undefined, 'fa', 'en', 'ar']);
    });

    it('describes each command in the language it was published for', async () => {
      const { registrar, clients } = build({
        env: { DOMAIN_NAME: 'txnet.io', BOT_COMMAND_LANGS: 'en' },
      });

      await registrar.onApplicationBootstrap();

      const [list, lang] = clients.telegram?.setMyCommands.mock.calls[1] ?? [];
      expect(lang).toBe('en');
      expect(list).toEqual(
        expect.arrayContaining([
          { command: 'start', description: 'en:bot.command.start' },
        ]),
      );
    });

    it('is published even for a platform with no webhook base', async () => {
      // Discovery does not depend on being reachable: the menu is per-token.
      const { registrar, clients } = build();

      await registrar.onApplicationBootstrap();

      expect(clients.telegram?.setMyCommands).toHaveBeenCalled();
    });
  });
});
