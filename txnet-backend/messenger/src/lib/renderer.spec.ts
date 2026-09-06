import { BotTranslator, BotView } from './bot-view';
import { MESSENGER_CAPABILITIES } from './capabilities';
import { BotViewRenderer } from './renderer';

// The renderer resolves nothing: it is handed a translator, so a test can read
// keys back verbatim and assert on structure instead of on Persian strings.
const t: BotTranslator = (text) => text.key ?? text.raw ?? '';

const view: BotView = {
  id: 'login.channels',
  body: { key: 'bot.login.pickChannel' },
  actions: [
    [{ id: 'channel:sms', label: { key: 'bot.channel.sms' } }],
    [{ id: 'channel:bale', label: { key: 'bot.channel.bale' } }],
  ],
};

describe('BotViewRenderer', () => {
  let renderer: BotViewRenderer;
  const original = { ...MESSENGER_CAPABILITIES.bale };

  beforeEach(() => {
    renderer = new BotViewRenderer();
    Object.assign(MESSENGER_CAPABILITIES.bale, original);
  });
  afterAll(() => Object.assign(MESSENGER_CAPABILITIES.bale, original));

  it('renders choices as an inline keyboard when the platform has one', () => {
    const out = renderer.render('telegram', view, t);

    expect(out.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: 'bot.channel.sms', callback_data: 'channel:sms' }],
        [{ text: 'bot.channel.bale', callback_data: 'channel:bale' }],
      ],
    });
    expect(out.degradations).toEqual([]);
    expect(out.numbered).toBe(false);
  });

  it('degrades to a numbered reply keyboard when inline keyboards are gone', () => {
    Object.assign(MESSENGER_CAPABILITIES.bale, { inlineKeyboard: false });

    const out = renderer.render('bale', view, t);

    expect(out.replyMarkup).toMatchObject({
      keyboard: [[{ text: '1. bot.channel.sms' }], [{ text: '2. bot.channel.bale' }]],
    });
    expect(out.numbered).toBe(true);
    // A substitution is observable, or "works on Telegram, not on Bale" is an
    // investigation instead of a query (F-302).
    expect(out.degradations).toEqual([
      {
        platform: 'bale',
        capability: 'inlineKeyboard',
        view: 'login.channels',
        substitute: 'reply keyboard with numbered labels',
      },
    ]);
  });

  it('degrades all the way to a numbered text list, and the flow still works', () => {
    Object.assign(MESSENGER_CAPABILITIES.bale, {
      inlineKeyboard: false,
      replyKeyboard: false,
    });

    const out = renderer.render('bale', view, t);

    expect(out.replyMarkup).toBeUndefined();
    expect(out.text).toBe(
      'bot.login.pickChannel\n1. bot.channel.sms\n2. bot.channel.bale',
    );
    // The point of the whole abstraction: the flow reads the same answer back.
    expect(renderer.matchAction(view, t, '2')).toBe('channel:bale');
  });

  it('renders a contact request as a reply keyboard, whatever else it could do', () => {
    const contactView: BotView = {
      id: 'register.contact',
      body: { key: 'bot.register.askContact' },
      actions: [
        [{ id: 'share', kind: 'contact', label: { key: 'bot.register.shareButton' } }],
      ],
    };

    const out = renderer.render('telegram', contactView, t);

    expect(out.replyMarkup).toMatchObject({
      keyboard: [[{ text: 'bot.register.shareButton', request_contact: true }]],
    });
  });

  it('substitutes a plain URL button when the platform has no WebApp', () => {
    Object.assign(MESSENGER_CAPABILITIES.bale, { webApp: false });
    const webAppView: BotView = {
      id: 'menu',
      body: { key: 'bot.menu.body' },
      actions: [
        [
          {
            id: 'open',
            kind: 'web_app',
            label: { key: 'bot.menu.open' },
            url: 'https://panel.example.test/',
          },
        ],
      ],
    };

    const out = renderer.render('bale', webAppView, t);

    expect(out.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: 'bot.menu.open', url: 'https://panel.example.test/' }],
      ],
    });
    expect(out.degradations[0]).toMatchObject({ capability: 'webApp' });
  });

  it('hands over a link instead of failing when media is over the ceiling', () => {
    const mediaView: BotView = {
      id: 'usage.chart',
      body: { key: 'bot.usage.body' },
      media: {
        kind: 'photo',
        url: 'https://cdn.example.test/chart.png',
        sizeBytes: 40 * 1024 * 1024,
      },
    };

    const out = renderer.render('telegram', mediaView, t);

    expect(out.text).toContain('https://cdn.example.test/chart.png');
    expect(out.degradations[0]).toMatchObject({ capability: 'photoUploadBytes' });
  });

  describe('matchAction', () => {
    it('matches an inline callback id, a number, and the label itself', () => {
      expect(renderer.matchAction(view, t, 'channel:sms')).toBe('channel:sms');
      expect(renderer.matchAction(view, t, '1')).toBe('channel:sms');
      expect(renderer.matchAction(view, t, '2. bot.channel.bale')).toBe(
        'channel:bale',
      );
      expect(renderer.matchAction(view, t, 'bot.channel.bale')).toBe(
        'channel:bale',
      );
    });

    it('returns null for free text, so a flow can tell it from a choice', () => {
      expect(renderer.matchAction(view, t, '09121234567')).toBeNull();
      expect(renderer.matchAction(view, t, '9')).toBeNull();
    });
  });
});

describe('BotViewRenderer — a screen that orients the reader', () => {
  const t = (text: { key?: string; raw?: string }) => text.raw ?? text.key ?? '';

  it('reads hint, then where you are, then what you said, then the question', () => {
    const rendered = new BotViewRenderer().render(
      'telegram',
      {
        id: 'register.name',
        hint: { raw: 'that username is taken' },
        header: { raw: 'step 3 of 6' },
        summary: [{ raw: 'Number: 0912' }],
        body: { raw: 'What is your full name?' },
        footer: { raw: 'Main menu' },
      },
      t,
    );

    expect(rendered.text).toBe(
      'that username is taken\nstep 3 of 6\nNumber: 0912\n\nWhat is your full name?\n\nMain menu',
    );
  });

  it('keeps the way out on the share-your-number screen', () => {
    // A reply keyboard is the only way to ask for a contact, and everything
    // else on the view used to be dropped to build one — leaving the screen a
    // user is most likely to refuse with nothing to refuse it with.
    const rendered = new BotViewRenderer().render(
      'telegram',
      {
        id: 'register.phone',
        body: { raw: 'Share your number' },
        actions: [
          [{ id: 'contact:share', kind: 'contact', label: { raw: 'Share my number' } }],
          [{ id: 'nav:cancel', label: { raw: 'Cancel' } }],
        ],
      },
      t,
    );

    expect(rendered.replyMarkup).toEqual({
      keyboard: [
        [{ text: 'Share my number', request_contact: true }],
        [{ text: 'Cancel' }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    });
  });
});
