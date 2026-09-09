import { NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import {
  aBotIntegration,
  BotClientRegistry,
  BotIntegration,
  BotUpdate,
} from '@txnet-backend/messenger';
import { BotDispatcher } from '../conversation/bot.dispatcher';
import { UpdateNormalizer } from './update.normalizer';
import { WebhookController } from './webhook.controller';

/**
 * The bot's front door, and the only route in the service that is reachable
 * from the internet. Its three rules are stated in the class doc and are worth
 * a test each, because all three fail silently:
 *
 *   - every refusal is a bare 404, identical to a route that does not exist.
 *     A wrong path that answered 401 turns the path into something that can be
 *     probed until it is found;
 *   - the tenant comes from the path and never from the body (F-320). A body
 *     is written by whoever sent the update, so a tenancy decision taken from
 *     it is a tenancy decision taken by a stranger;
 *   - once the path and the secret are right the answer is always 200. A
 *     thrown handler that escaped as a 500 would make the platform redeliver
 *     the same update, and a redelivered update replays whatever the flow
 *     already did.
 */

const SECRET = 'a-very-unguessable-secret';
const PATH = 'p'.repeat(43);

const telegram = aBotIntegration({ webhookPath: PATH });
const bale = aBotIntegration({
  id: 'i-bale',
  platform: 'bale',
  webhookPath: PATH,
});

function request(headers: Record<string, string> = {}) {
  return {
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

const update = {
  message: { chat: { id: 5501 }, from: { id: 991 }, text: '/start' },
} as unknown as BotUpdate;

const ctx = {
  integration: telegram,
  platform: 'telegram' as const,
  chatId: '5501',
  lang: 'fa',
  text: '/start',
};

/**
 * The registry as this route uses it: a path resolves to an integration or to
 * nothing, and a candidate secret is or is not that integration's.
 */
function controller({
  integrations = { [PATH]: telegram } as Record<string, BotIntegration>,
  secret = SECRET as string | null,
  normalize = jest.fn(() => ctx),
  handle = jest.fn(async () => undefined),
} = {}) {
  const byWebhookPath = jest.fn(
    async (platform: string, path: string) =>
      integrations[path]?.platform === platform ? integrations[path] : null,
  );
  const verifyWebhookSecret = jest.fn(
    async (_i: BotIntegration, candidate: string) =>
      secret !== null && candidate === secret,
  );
  const bots = {
    byWebhookPath,
    verifyWebhookSecret,
  } as unknown as BotClientRegistry;

  const c = new WebhookController(
    bots,
    { normalize } as unknown as UpdateNormalizer,
    { handle } as unknown as BotDispatcher,
  );
  return { c, byWebhookPath, verifyWebhookSecret, normalize, handle };
}

const header = { 'x-telegram-bot-api-secret-token': SECRET };

describe('WebhookController', () => {
  it('resolves the integration from the path and dispatches the update', async () => {
    const { c, byWebhookPath, normalize, handle } = controller();

    await expect(
      c.webhook('telegram', PATH, update, request(header)),
    ).resolves.toEqual({ ok: true });

    expect(byWebhookPath).toHaveBeenCalledWith('telegram', PATH);
    // The integration reaches the flows on the context, which is how every
    // downstream call names its tenant (F-320, F-065-a).
    expect(normalize).toHaveBeenCalledWith('telegram', telegram, update);
    expect(handle).toHaveBeenCalledWith(ctx);
  });

  it('serves both platforms', async () => {
    const { c, normalize } = controller({ integrations: { [PATH]: bale } });

    await c.webhook('bale', PATH, update, request());

    expect(normalize).toHaveBeenCalledWith('bale', bale, update);
  });

  describe('answers a bare 404 to anything that is not the exact path', () => {
    it('an unknown platform', async () => {
      const { c, handle } = controller();
      await expect(
        c.webhook('whatsapp', PATH, update, request(header)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handle).not.toHaveBeenCalled();
    });

    it('a path no integration owns', async () => {
      const { c, handle } = controller();
      await expect(
        c.webhook('telegram', 'q'.repeat(43), update, request(header)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handle).not.toHaveBeenCalled();
    });

    it('an empty path', async () => {
      const { c } = controller();
      await expect(
        c.webhook('telegram', '', update, request(header)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("another platform's path replayed against this route", async () => {
      // The path is unique platform-wide, so a Bale path posted to the
      // Telegram route resolves to a row — and must still be refused.
      const { c, handle } = controller({ integrations: { [PATH]: bale } });
      await expect(
        c.webhook('telegram', PATH, update, request(header)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handle).not.toHaveBeenCalled();
    });

    it('a Telegram request with no secret header at all', async () => {
      // Telegram echoes back whatever `setWebhook` registered, so a missing
      // header on that platform is a forged request (F-321).
      const { c, handle } = controller();
      await expect(
        c.webhook('telegram', PATH, update, request()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handle).not.toHaveBeenCalled();
    });

    it('a secret header that is not this integration’s', async () => {
      const { c, handle } = controller();
      await expect(
        c.webhook(
          'telegram',
          PATH,
          update,
          request({ 'x-telegram-bot-api-secret-token': 'wrong' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handle).not.toHaveBeenCalled();
    });

    it('a Bale request that sent a header, and sent a wrong one', async () => {
      // Bale is not required to send the field; sending the wrong one is still
      // never waved through.
      const { c, handle } = controller({ integrations: { [PATH]: bale } });
      await expect(
        c.webhook(
          'bale',
          PATH,
          update,
          request({ 'x-telegram-bot-api-secret-token': 'wrong' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handle).not.toHaveBeenCalled();
    });
  });

  it('accepts a Bale request with no secret header', async () => {
    // Bale ignores the field; the 32-byte path alone is its guard.
    const { c, handle } = controller({ integrations: { [PATH]: bale } });

    await c.webhook('bale', PATH, update, request());

    expect(handle).toHaveBeenCalled();
  });

  it('answers 200 for an update the normalizer dropped', async () => {
    // A message from another bot is nothing to do — but redelivering it
    // forever is worse than ignoring it once.
    const { c, handle } = controller({ normalize: jest.fn(() => null) });

    await expect(
      c.webhook('telegram', PATH, update, request(header)),
    ).resolves.toEqual({ ok: true });
    expect(handle).not.toHaveBeenCalled();
  });

  it('checks the path and the secret before it looks at the payload', async () => {
    // A normalizer that ran first would be parsing attacker-supplied JSON on
    // a path whose secret was never checked.
    const { c, normalize } = controller();

    await expect(
      c.webhook(
        'telegram',
        PATH,
        update,
        request({ 'x-telegram-bot-api-secret-token': 'wrong' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(normalize).not.toHaveBeenCalled();
  });
});
