import { BotUpdate } from '@txnet-backend/messenger';
import { LocaleService } from '../locale/locale.service';
import { UpdateNormalizer } from './update.normalizer';

/**
 * The normalizer is the only place in `bot-service` that touches a payload the
 * platform wrote, and nothing above it re-checks the shape. So the two things
 * worth pinning are what it *drops* — an update with no addressable chat, and
 * one from another bot — and that the language a messenger claims is resolved
 * against what locale-service serves rather than trusted verbatim. A
 * `language_code` copied straight through would put an unserved locale into
 * every downstream lookup.
 */

// A locale service that knows two languages and falls back to fa.
function locale() {
  return {
    resolveLanguage: jest.fn((code?: string) =>
      code && ['en', 'fa'].includes(code.split('-')[0]) ? code.split('-')[0] : 'fa',
    ),
  } as unknown as LocaleService;
}

function normalizer(svc = locale()) {
  return { normalizer: new UpdateNormalizer(svc), locale: svc };
}

describe('UpdateNormalizer', () => {
  it('turns a text message into a ChatContext', () => {
    const { normalizer: n } = normalizer();

    const ctx = n.normalize('telegram', {
      message: {
        message_id: 42,
        chat: { id: 5501 },
        from: { id: 991, language_code: 'en-GB' },
        text: '/start',
      },
    } as unknown as BotUpdate);

    expect(ctx).toEqual({
      platform: 'telegram',
      chatId: '5501',
      senderId: 991,
      lang: 'en',
      text: '/start',
      contact: undefined,
      messageId: 42,
    });
  });

  it('stringifies a numeric chat id, so a Redis key is never built from a number', () => {
    // RedisKeys.botNav takes a string; a number would key
    // `bot:nav:telegram:5501` here and `...:5501` there only by luck of
    // coercion, and a mismatch is a chat that silently loses its state.
    const { normalizer: n } = normalizer();
    const ctx = n.normalize('bale', {
      message: { chat: { id: 5501 }, from: { id: 1 }, text: 'hi' },
    } as unknown as BotUpdate);

    expect(ctx?.chatId).toBe('5501');
    expect(typeof ctx?.chatId).toBe('string');
  });

  it('reads a callback query off the message it was attached to', () => {
    const { normalizer: n } = normalizer();

    const ctx = n.normalize('telegram', {
      callback_query: {
        id: 'cbq-1',
        data: 'login:otp',
        from: { id: 991, language_code: 'fa' },
        message: { chat: { id: 5501 } },
      },
    } as unknown as BotUpdate);

    expect(ctx).toMatchObject({
      chatId: '5501',
      senderId: 991,
      callbackData: 'login:otp',
      callbackQueryId: 'cbq-1',
      lang: 'fa',
    });
    // A tap is not typing: text must not be invented from the payload.
    expect(ctx?.text).toBeUndefined();
  });

  it('prefers the callback query when an update somehow carries both', () => {
    const { normalizer: n } = normalizer();

    const ctx = n.normalize('telegram', {
      callback_query: {
        id: 'cbq-1',
        data: 'menu:back',
        from: { id: 1 },
        message: { chat: { id: 111 } },
      },
      message: { chat: { id: 222 }, from: { id: 1 }, text: 'typed' },
    } as unknown as BotUpdate);

    expect(ctx?.chatId).toBe('111');
    expect(ctx?.callbackData).toBe('menu:back');
  });

  it('carries a shared contact card through untouched', () => {
    // The contact is the credential in the link flow (ADR-0012); the
    // normalizer must not reshape or partially copy it.
    const { normalizer: n } = normalizer();
    const contact = {
      phone_number: '+989121112233',
      first_name: 'Ada',
      user_id: 991,
    };

    const ctx = n.normalize('telegram', {
      message: { chat: { id: 5501 }, from: { id: 991 }, contact },
    } as unknown as BotUpdate);

    expect(ctx?.contact).toBe(contact);
  });

  it('resolves the messenger language hint instead of trusting it', () => {
    const { normalizer: n, locale: svc } = normalizer();

    const ctx = n.normalize('telegram', {
      message: { chat: { id: 1 }, from: { id: 2, language_code: 'de-DE' }, text: 'x' },
    } as unknown as BotUpdate);

    expect(svc.resolveLanguage).toHaveBeenCalledWith('de-DE');
    expect(ctx?.lang).toBe('fa');
  });

  it('still resolves a language when the update carries no hint', () => {
    const { normalizer: n, locale: svc } = normalizer();

    const ctx = n.normalize('bale', {
      message: { chat: { id: 1 }, from: { id: 2 }, text: 'x' },
    } as unknown as BotUpdate);

    expect(svc.resolveLanguage).toHaveBeenCalledWith(undefined);
    expect(ctx?.lang).toBe('fa');
  });

  describe('drops what it cannot address', () => {
    const cases: Array<[string, unknown]> = [
      ['an empty update', {}],
      ['a null update', null],
      ['an undefined update', undefined],
      ['a message with no chat', { message: { from: { id: 1 }, text: 'x' } }],
      ['a message whose chat has no id', { message: { chat: {}, from: { id: 1 } } }],
      ['a callback query with no message', { callback_query: { id: 'c', from: { id: 1 } } }],
      [
        'a message from another bot',
        { message: { chat: { id: 1 }, from: { id: 2, is_bot: true }, text: 'x' } },
      ],
      ['an update kind the bot does not handle', { edited_message: { chat: { id: 1 } } }],
    ];

    it.each(cases)('%s', (_name, update) => {
      const { normalizer: n } = normalizer();
      expect(n.normalize('telegram', update as BotUpdate)).toBeNull();
    });
  });

  it('falls back to the message when a callback query has no addressable chat', () => {
    // A malformed callback must not swallow a perfectly good message.
    const { normalizer: n } = normalizer();

    const ctx = n.normalize('telegram', {
      callback_query: { id: 'c', from: { id: 1 } },
      message: { chat: { id: 5501 }, from: { id: 1 }, text: 'typed' },
    } as unknown as BotUpdate);

    expect(ctx).toMatchObject({ chatId: '5501', text: 'typed' });
  });

  it('drops a non-string text rather than passing it to the flows', () => {
    // Every flow does string work on `text`; a number here becomes a
    // `.trim is not a function` several layers away from the cause.
    const { normalizer: n } = normalizer();

    const ctx = n.normalize('telegram', {
      message: { chat: { id: 1 }, from: { id: 2 }, text: 12345 },
    } as unknown as BotUpdate);

    expect(ctx).not.toBeNull();
    expect(ctx?.text).toBeUndefined();
  });

  it('keeps an empty string as an empty string', () => {
    const { normalizer: n } = normalizer();
    const ctx = n.normalize('telegram', {
      message: { chat: { id: 1 }, from: { id: 2 }, text: '' },
    } as unknown as BotUpdate);

    expect(ctx?.text).toBe('');
  });

  it('carries the platform it was told, not one read off the payload', () => {
    // The two platforms number their chats independently (ADR-0015): the
    // platform comes from the webhook path, never from the update.
    const { normalizer: n } = normalizer();
    const update = {
      message: { chat: { id: 5501 }, from: { id: 1 }, text: 'x' },
    } as unknown as BotUpdate;

    expect(n.normalize('telegram', update)?.platform).toBe('telegram');
    expect(n.normalize('bale', update)?.platform).toBe('bale');
  });

  it('accepts a message with no sender rather than dropping it', () => {
    // Channel posts and some Bale updates have no `from`; they are still a
    // chat the bot can answer.
    const { normalizer: n } = normalizer();
    const ctx = n.normalize('bale', {
      message: { chat: { id: 77 }, text: '/start' },
    } as unknown as BotUpdate);

    expect(ctx).toMatchObject({ chatId: '77', senderId: undefined, text: '/start' });
  });
});
