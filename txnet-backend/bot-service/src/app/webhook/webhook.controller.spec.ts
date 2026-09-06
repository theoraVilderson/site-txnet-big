import { NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { BotClientRegistry, BotUpdate } from '@txnet-backend/messenger';
import { BotDispatcher } from '../conversation/bot.dispatcher';
import { UpdateNormalizer } from './update.normalizer';
import { WebhookController } from './webhook.controller';

/**
 * The bot's front door, and the only route in the service that is reachable
 * from the internet. Its two rules are stated in the class doc and are worth a
 * test each, because both fail silently:
 *
 *   - every refusal is a bare 404, identical to a route that does not exist.
 *     A wrong secret that answered 401 — or that answered *faster* — turns the
 *     path into something that can be probed until it is found;
 *   - once the path is right the answer is always 200. A thrown handler that
 *     escaped as a 500 would make the platform redeliver the same update, and
 *     a redelivered update replays whatever the flow already did.
 */

const SECRET = 'a-very-unguessable-secret';

function registry(secret: string | undefined = SECRET) {
  return {
    webhookSecret: jest.fn(() => secret),
  } as unknown as BotClientRegistry;
}

/** A registry for a platform whose bot was never configured. */
function unconfiguredRegistry() {
  return {
    webhookSecret: jest.fn(() => undefined),
  } as unknown as BotClientRegistry;
}

function request(headers: Record<string, string> = {}) {
  return {
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

const update = {
  message: { chat: { id: 5501 }, from: { id: 991 }, text: '/start' },
} as unknown as BotUpdate;

const ctx = { platform: 'telegram' as const, chatId: '5501', lang: 'fa', text: '/start' };

function controller({
  bots = registry(),
  normalize = jest.fn(() => ctx),
  handle = jest.fn(async () => undefined),
} = {}) {
  const c = new WebhookController(
    bots,
    { normalize } as unknown as UpdateNormalizer,
    { handle } as unknown as BotDispatcher,
  );
  return { c, bots, normalize, handle };
}

describe('WebhookController', () => {
  it('normalizes and dispatches an update on the right path', async () => {
    const { c, normalize, handle } = controller();

    await expect(c.webhook('telegram', SECRET, update, request())).resolves.toEqual({
      ok: true,
    });

    expect(normalize).toHaveBeenCalledWith('telegram', update);
    expect(handle).toHaveBeenCalledWith(ctx);
  });

  it('serves both platforms', async () => {
    const { c, normalize } = controller();

    await c.webhook('bale', SECRET, update, request());

    expect(normalize).toHaveBeenCalledWith('bale', update);
  });

  describe('answers a bare 404 to anything that is not the exact path', () => {
    it('an unknown platform', async () => {
      const { c, handle } = controller();
      await expect(c.webhook('whatsapp', SECRET, update, request())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(handle).not.toHaveBeenCalled();
    });

    it('a wrong secret', async () => {
      const { c, handle } = controller();
      await expect(
        c.webhook('telegram', 'a-very-unguessable-secreT', update, request()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handle).not.toHaveBeenCalled();
    });

    it('a secret of the wrong length', async () => {
      // The length check is what keeps timingSafeEqual from throwing; a throw
      // here would be a 500, and a 500 is a different answer from a 404.
      const { c } = controller();
      await expect(c.webhook('telegram', 'short', update, request())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        c.webhook('telegram', SECRET + 'extra', update, request()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('an empty secret', async () => {
      const { c } = controller();
      await expect(c.webhook('telegram', '', update, request())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a bot that has no secret configured', async () => {
      // An unconfigured bot must not accept every request; `!expected` has to
      // refuse rather than fall through to a compare against "".
      const { c } = controller({ bots: unconfiguredRegistry() });
      await expect(c.webhook('telegram', '', update, request())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(c.webhook('telegram', SECRET, update, request())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a Telegram secret header that disagrees with the path', async () => {
      const { c, handle } = controller();
      await expect(
        c.webhook(
          'telegram',
          SECRET,
          update,
          request({ 'x-telegram-bot-api-secret-token': 'wrong' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handle).not.toHaveBeenCalled();
    });
  });

  it('accepts the Telegram secret header when it matches', async () => {
    const { c, handle } = controller();

    await c.webhook(
      'telegram',
      SECRET,
      update,
      request({ 'x-telegram-bot-api-secret-token': SECRET }),
    );

    expect(handle).toHaveBeenCalled();
  });

  it('accepts a request with no secret header at all', async () => {
    // Bale ignores the field; the path alone is its guard.
    const { c, handle } = controller();

    await c.webhook('bale', SECRET, update, request());

    expect(handle).toHaveBeenCalled();
  });

  it('answers 200 for an update the normalizer dropped', async () => {
    // A message from another bot is nothing to do — but redelivering it
    // forever is worse than ignoring it once.
    const { c, handle } = controller({ normalize: jest.fn(() => null) });

    await expect(c.webhook('telegram', SECRET, update, request())).resolves.toEqual({
      ok: true,
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('checks the secret before it looks at the payload', async () => {
    // A normalizer that ran first would be parsing attacker-supplied JSON on
    // a path whose secret was never checked.
    const { c, normalize } = controller();

    await expect(
      c.webhook('telegram', 'wrong-secret-here-ok', update, request()),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(normalize).not.toHaveBeenCalled();
  });
});
