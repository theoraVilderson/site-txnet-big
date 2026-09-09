import { ConfigService } from '@nestjs/config';
import { BotViewRenderer } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BotCopy } from '../locale/bot-copy';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatLanguage } from '../locale/chat-language';
import { LocaleService } from '../locale/locale.service';
import { AccountAddFlow } from '../flows/account-add.flow';
import { PhoneNumbers } from '../flows/phone-number';
import { AccountsFlow } from '../flows/accounts.flow';
import { AccountSwitcher } from '../session/account-switcher';
import { ChatAccess } from '../session/chat-access';
import { ForgotFlow } from '../flows/forgot.flow';
import { LoginFlow } from '../flows/login.flow';
import { RegisterFlow } from '../flows/register.flow';
import { OtpStep } from '../flows/otp.step';
import { ConversationStore } from './conversation.store';
import { ConversationRouter, PANEL_LINK_STEP } from './router';
import { ChatContext, NavState } from './nav.types';

// The translator is the identity function on keys: these specs are about which
// screen comes next, not about wording.
const copy = { translator: () => (t: { key?: string }) => t.key ?? '' } as unknown as BotCopy;

function makeRouter(over: {
  session?: unknown;
  state?: NavState | null;
  api?: Partial<AuthApiClient>;
  otp?: Partial<OtpStep>;
  langs?: Partial<ChatLanguage>;
} = {}) {
  const nav = {
    get: jest.fn().mockResolvedValue(over.state ?? null),
    save: jest.fn(),
    clear: jest.fn(),
  } as unknown as ConversationStore;
  const sessions = {
    get: jest.fn().mockResolvedValue(over.session ?? null),
    clear: jest.fn(),
    save: jest.fn(),
  } as unknown as BotSessionStore;
  const api = { logout: jest.fn().mockResolvedValue({ ok: true, msg: 'ok' }), ...over.api } as unknown as AuthApiClient;
  const otp = { submitContact: jest.fn(), ...over.otp } as unknown as OtpStep;

  const langs = {
    resolve: jest.fn(async (_p: unknown, _c: unknown, hint: string) => hint),
    chosen: jest.fn().mockResolvedValue(null),
    choose: jest.fn().mockResolvedValue(true),
    ...over.langs,
  } as unknown as ChatLanguage;
  const locale = {
    locales: jest.fn().mockResolvedValue([
      { code: 'fa', native_name: 'فارسی' },
      { code: 'en', native_name: 'English' },
    ]),
    languages: () => ['fa', 'en'],
  } as unknown as LocaleService;

  const phones = new PhoneNumbers(new ConfigService({ DEFAULT_LANGUAGE: 'fa' }));

  const router = new ConversationRouter(
    nav,
    sessions,
    new BotViewRenderer(),
    copy,
    langs,
    locale,
    api,
    otp,
    new LoginFlow(api, otp, sessions, phones),
    new RegisterFlow(api, otp, sessions, phones),
    new ForgotFlow(api, otp, sessions, phones),
    new AccountsFlow(
      api,
      new ChatAccess(api, sessions),
      sessions,
      new AccountSwitcher(api, sessions),
    ),
    new AccountAddFlow(
      api,
      new ChatAccess(api, sessions),
      otp,
      new AccountSwitcher(api, sessions),
      phones,
    ),
    new ConfigService({ PANEL_BASE_URL: 'https://panel.example.test' }),
  );
  return { router, nav, sessions, api, otp, langs, locale };
}

const ctx: ChatContext = { platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };

describe('ConversationRouter', () => {
  describe('/start', () => {
    it('shows the guest menu to a chat with no session', async () => {
      const { router } = makeRouter();

      const result = await router.route({ ...ctx, text: '/start' });

      expect(result.view.id).toBe('menu.guest');
      expect(result.nextState).toBeNull();
    });

    it('shows the member menu only when a session exists — never for a known chat id', async () => {
      const { router } = makeRouter({ session: { refreshToken: 'r-1', signedInAt: 1 } });

      const result = await router.route({ ...ctx, text: '/start' });

      expect(result.view.id).toBe('menu.member');
      // The switcher is only reachable from here (`F-0210`), so a member menu
      // without it makes the capability invisible.
      expect((result.view.actions ?? []).flat().map((a) => a.id)).toContain(
        'menu:accounts',
      );
    });

    it('finishes a panel-started link instead of opening a menu (F-0203)', async () => {
      const linkResolve = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: { state: 'pending', needsContact: true, otpSent: false, messageKey: 'askContact', lang: 'fa' },
      });
      const { router } = makeRouter({ api: { linkResolve } });

      const result = await router.route({
        ...ctx,
        text: '/start Zm9vYmFyYmF6cXV4MTIzNA',
      });

      expect(linkResolve).toHaveBeenCalledWith(
        expect.objectContaining({ startToken: 'Zm9vYmFyYmF6cXV4MTIzNA' }),
        expect.anything(),
      );
      expect(result.view.id).toBe('link.contact');
      expect(result.nextState?.step).toBe(PANEL_LINK_STEP);
    });

    it('lands an unrecognised payload on the menu rather than failing', async () => {
      // It arrives from outside: untrusted input, not a command.
      const { router } = makeRouter();

      const result = await router.route({ ...ctx, text: '/start ../../etc/passwd' });

      expect(result.view.id).toBe('menu.guest');
    });
  });

  describe('leaving', () => {
    it('/logout revokes the session at auth-api and drops the chat’s own', async () => {
      const logout = jest.fn().mockResolvedValue({ ok: true, msg: 'ok' });
      const { router, sessions } = makeRouter({
        session: { refreshToken: 'r-1', signedInAt: 1 },
        api: { logout },
      });

      const result = await router.route({ ...ctx, text: '/logout' });

      expect(logout).toHaveBeenCalledWith({ refreshToken: 'r-1' }, expect.anything());
      expect(sessions.clear).toHaveBeenCalledWith('telegram', '5501');
      expect(result.view.id).toBe('signedOut');
    });

    it('cancel ends whatever flow was in progress', async () => {
      const { router } = makeRouter({
        state: { flow: 'register', step: 'register.name', data: {} },
      });

      const result = await router.route({ ...ctx, callbackData: 'nav:cancel' });

      expect(result.view.id).toBe('cancelled');
      expect(result.nextState).toBeNull();
    });
  });

  describe('reading an answer back', () => {
    it('accepts a typed number when the platform had no buttons to tap', async () => {
      // This is what makes the F-302 numbered-list fallback a real path.
      const lastView = {
        id: 'menu.guest',
        body: { key: 'bot.menu.guest' },
        actions: [
          [{ id: 'menu:login', label: { key: 'bot.action.login' } }],
          [{ id: 'menu:register', label: { key: 'bot.action.register' } }],
        ],
      };
      const { router } = makeRouter({
        state: { flow: 'login', step: 'login.method', data: {}, lastView },
      });

      const result = await router.route({ ...ctx, text: '2' });

      expect(result.view.id).toBe('register.phone');
    });

    it('treats free text as free text, not as a choice', async () => {
      const lastView = {
        id: 'login.phone',
        body: { key: 'bot.login.askPhone' },
        actions: [[{ id: 'contact:share', kind: 'contact' as const, label: { key: 'bot.action.shareContact' } }]],
      };
      const { router } = makeRouter({
        state: { flow: 'login', step: 'login.identifier', data: {}, lastView },
      });

      const result = await router.route({ ...ctx, text: 'sara' });

      expect(result.view.id).toBe('login.password');
      expect(result.nextState?.data.identifier).toBe('sara');
    });
  });

  it('hands the panel-link contact to identity and stops there', async () => {
    const submitContact = jest.fn().mockResolvedValue({
      view: { id: 'otp.code', body: { key: 'bot.login.askCode' } },
      nextState: { flow: 'login', step: 'login.code', data: {} },
    });
    const { router } = makeRouter({
      state: { flow: 'login', step: PANEL_LINK_STEP, data: {} },
      otp: { submitContact },
    });

    const result = await router.route({
      ...ctx,
      contact: { phone_number: '989121112233', user_id: 42 },
    });

    expect(submitContact).toHaveBeenCalled();
    // The user finishes on the website they started from; the bot does not
    // start a conversation of its own here.
    expect(result.nextState).toBeNull();
  });
});

/**
 * The screen a user actually sees is `dispatch` plus `decorate`, and every
 * confusion this suite is about lived in the gap between them: a sentence with
 * no buttons, a step with no way back, a conversation that vanished without
 * saying so. These lock the decoration, not the wording.
 */
describe('ConversationRouter — orientation', () => {
  const inRegister: NavState = {
    flow: 'register',
    step: 'register.name',
    data: { phoneNumber: '09121112233' },
    lastView: {
      id: 'register.name',
      body: { key: 'bot.register.askName' },
      actions: [[{ id: 'nav:cancel', label: { key: 'bot.action.cancel' } }]],
    },
  };

  it('never ends a conversation on a screen with nothing on it', async () => {
    const { router } = makeRouter();

    const result = await router.route({ ...ctx, text: '/cancel' });

    expect(result.nextState).toBeNull();
    expect(result.view.footer?.key).toBe('bot.menu.guest');
    expect((result.view.actions ?? []).flat().map((a) => a.id)).toContain(
      'menu:login',
    );
  });

  it('says a conversation expired instead of answering with a bare menu', async () => {
    const { router } = makeRouter({ state: null });

    const result = await router.route({ ...ctx, text: 'Theora Vilderson' });

    expect(result.view.id).toBe('expired');
    expect((result.view.actions ?? []).flat().length).toBeGreaterThan(0);
  });

  it('tells the user where they are and what they have already said', async () => {
    const { router } = makeRouter({ state: inRegister });

    const result = await router.route({ ...ctx, text: 'Theora Vilderson' });

    expect(result.view.header).toEqual({
      key: 'bot.progress.register',
      values: { n: 3, total: 6 },
    });
    expect(result.view.summary).toContainEqual({
      key: 'bot.field.phone',
      values: { value: '09121112233' },
    });
  });

  it('offers Back once there is somewhere to go back to, and walks it', async () => {
    const { router } = makeRouter({ state: inRegister });

    const forward = await router.route({ ...ctx, text: 'Theora Vilderson' });
    expect(forward.nextState?.history).toHaveLength(1);
    expect((forward.view.actions ?? []).flat().map((a) => a.id)).toContain(
      'nav:back',
    );

    const back = await makeRouter({
      state: forward.nextState as NavState,
    }).router.route({ ...ctx, callbackData: 'nav:back' });

    expect(back.nextState?.step).toBe('register.name');
    expect(back.nextState?.history).toHaveLength(0);
    expect(back.view.id).toBe('register.name');
  });

  it('re-asks the question with the reason on it, rather than a dead end', async () => {
    // What `auth-api` said arrives as a view with words and no choices. The
    // user is still on the same step, so it belongs *above that step's
    // question* — the state this used to leave the chat in had no keyboard at
    // all, on the screen where a password had just been rejected.
    const state: NavState = {
      ...inRegister,
      step: 'register.channel',
      data: { ...inRegister.data, username: 'theora' },
      lastView: {
        id: 'otp.channels',
        body: { key: 'bot.login.pickChannel' },
        actions: [
          [{ id: 'channel:sms', label: { key: 'bot.channel.sms' } }],
          [{ id: 'nav:cancel', label: { key: 'bot.action.cancel' } }],
        ],
      },
    };
    // The harness's `OtpStep` is a stub: a channel it does not recognise is
    // exactly the case this test is about.
    const { router } = makeRouter({
      state,
      otp: { channelFromAction: () => null } as Partial<OtpStep>,
    });

    const result = await router.route({ ...ctx, text: 'anything at all' });

    expect(result.view.hint).toEqual({ key: 'bot.common.pickOne' });
    expect((result.view.actions ?? []).flat().map((a) => a.id)).toContain(
      'channel:sms',
    );
  });

  it('answers /help without losing the question the user was on', async () => {
    const { router } = makeRouter({ state: inRegister });

    const result = await router.route({ ...ctx, text: '/help' });

    expect(result.view.hint).toEqual({ key: 'bot.help.body' });
    expect(result.view.body).toEqual({ key: 'bot.register.askName' });
    expect(result.nextState?.step).toBe('register.name');
  });
});

describe('ConversationRouter — language', () => {
  it('offers every served language in its own name, marking the current one', async () => {
    const { router } = makeRouter();

    const result = await router.route({ ...ctx, text: '/lang' });

    expect(result.view.id).toBe('language');
    expect((result.view.actions ?? []).flat().map((a) => a.label.raw)).toEqual([
      'فارسی ✅',
      'English',
      undefined, // Cancel, which is a key rather than a literal
    ]);
  });

  it('renders the reply in the language just chosen, on the same screen', async () => {
    const state: NavState = {
      flow: 'register',
      step: 'register.name',
      data: {},
      lastView: {
        id: 'register.name',
        body: { key: 'bot.register.askName' },
        actions: [[{ id: 'nav:cancel', label: { key: 'bot.action.cancel' } }]],
      },
    };
    const { router, langs } = makeRouter({ state });

    const result = await router.route({ ...ctx, callbackData: 'lang:en' });

    expect(langs.choose).toHaveBeenCalledWith('telegram', '5501', 'en');
    // `lang` is what the dispatcher renders with, so the confirmation is not
    // written in the language the user just asked to leave.
    expect(result.lang).toBe('en');
    expect(result.view.hint).toEqual({ key: 'bot.language.changed' });
    expect(result.view.body).toEqual({ key: 'bot.register.askName' });
    expect(result.nextState?.step).toBe('register.name');
  });
});
