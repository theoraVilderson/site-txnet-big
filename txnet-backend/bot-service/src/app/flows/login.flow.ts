import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotSessionStore } from '../session/bot-session.store';
import { OtpStep } from './otp.step';
import { PhoneNumbers } from './phone-number';
import { ACTIONS, ask, askContact, say } from './views';

/**
 * Signing in, exactly as the panel does it: a one-time code on a channel the
 * user picks, or a password. Every decision — is this phone known, is that
 * code right, is the account locked — belongs to `auth-api`; this file only
 * knows which question comes next.
 */
@Injectable()
export class LoginFlow {
  constructor(
    private readonly api: AuthApiClient,
    private readonly otp: OtpStep,
    private readonly sessions: BotSessionStore,
    private readonly phones: PhoneNumbers,
  ) {}

  /**
   * The fast path first (ADR-0012): this chat may already be a credential.
   *
   * `bots/session` answers in one round trip — signed in, or "send me your
   * contact card". Only when neither applies does the conversation fall back
   * to asking which way the user wants to prove themselves, which is what it
   * always used to open with.
   */
  async start(ctx?: ChatContext): Promise<FlowResult> {
    if (ctx) {
      const fast = await this.chatSession(ctx, { flow: 'login', step: 'login.chat', data: {} });
      if (fast) return fast;
    }
    return this.methodChoice();
  }

  private methodChoice(): FlowResult {
    return {
      view: ask('login.method', { key: 'bot.login.askIdentifier' }, [
        [{ id: ACTIONS.loginOtp, label: { key: 'bot.action.loginWithOtp' } }],
        [
          {
            id: ACTIONS.loginPassword,
            label: { key: 'bot.action.loginWithPassword' },
          },
        ],
      ]),
      nextState: { flow: 'login', step: 'login.method', data: {} },
    };
  }

  /**
   * One call, three possible answers: a session, a request for the contact
   * card, or nothing this path can do. `null` means the last one — the caller
   * carries on with the conversation it would have had anyway, because a chat
   * belonging to no account, or to a privileged one, is not an error.
   */
  private async chatSession(
    ctx: ChatContext,
    state: NavState,
  ): Promise<FlowResult | null> {
    const result = await this.api.botSession(
      { platform: ctx.platform, chatId: ctx.chatId, senderId: ctx.senderId },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
    );
    if (!result.ok || !result.data) return null;

    if (result.data.state === 'authenticated') {
      return this.signIn(ctx, result.data.tokens?.refreshToken);
    }
    return {
      view: askContact('login.chat', { key: 'bot.login.askChatContact' }),
      nextState: { ...state, step: 'login.chat' },
    };
  }

  /**
   * The contact card arrives and is both the link and the sign-in — one tap,
   * no phone typed, no code. A card that proves nothing useful (no account on
   * that number, a privileged role, a chat already taken) is not a dead end:
   * the ordinary ways in are still there, so the flow simply opens them with
   * `auth-api`'s own reason above them.
   */
  private async chatContact(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    if (!ctx.contact) {
      return {
        view: askContact('login.chat', { key: 'bot.login.askChatContact' }),
        nextState: state,
      };
    }
    const result = await this.api.botSession(
      {
        platform: ctx.platform,
        chatId: ctx.chatId,
        senderId: ctx.senderId,
        contact: ctx.contact,
      },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
    );
    if (result.ok && result.data?.state === 'authenticated') {
      return this.signIn(ctx, result.data.tokens?.refreshToken);
    }
    const fallback = this.methodChoice();
    return { ...fallback, view: { ...fallback.view, hint: { raw: result.msg } } };
  }

  async handle(
    ctx: ChatContext,
    state: NavState,
    actionId: string | null,
  ): Promise<FlowResult> {
    switch (state.step) {
      case 'login.method':
        // Which branch was taken is kept because the two are different
        // lengths, and "step 2 of 4" on a three-question path is a lie the
        // user finds out about at the end (`flows/steps.ts`).
        if (actionId === ACTIONS.loginPassword) {
          return {
            view: ask('login.identifier', { key: 'bot.login.askIdentifier' }),
            nextState: {
              ...state,
              step: 'login.identifier',
              data: { ...state.data, method: 'password' },
            },
          };
        }
        return {
          view: askContact('login.phone', { key: 'bot.login.askPhone' }),
          nextState: {
            ...state,
            step: 'login.phone',
            data: { ...state.data, method: 'otp' },
          },
        };

      case 'login.chat':
        return this.chatContact(ctx, state);

      case 'login.phone':
        return this.phone(ctx, state);

      case 'login.channel':
        return this.channel(ctx, state, actionId);

      case 'login.contact':
        return this.otp.submitContact(ctx, state);

      case 'login.link':
        if (actionId === ACTIONS.linkCheck) return this.otp.checkLink(ctx, state);
        return { view: say('login.wait', { key: 'bot.common.pickOne' }), nextState: state };

      case 'login.code':
        if (actionId === ACTIONS.resend) {
          return this.channel(ctx, state, `channel:${state.data.channel}`);
        }
        return this.code(ctx, state);

      case 'login.identifier':
        return {
          view: ask('login.password', { key: 'bot.login.askPassword' }),
          nextState: {
            ...state,
            step: 'login.password',
            data: { ...state.data, identifier: (ctx.text ?? '').trim() },
          },
        };

      case 'login.password':
        return this.password(ctx, state);

      default:
        return { view: say('login.lost', { key: 'bot.common.unknown' }), nextState: null };
    }
  }

  /**
   * The phone, shared as a contact or typed, read into the form `auth-api`
   * stores (`phone-number.ts`) — a shared contact from outside the
   * deployment's own region arrives without its `+` and is otherwise
   * unreadable. `auth-api` still decides whether the number is acceptable.
   */
  private async phone(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const phoneNumber = this.phones.read(
      ctx.contact?.phone_number ?? (ctx.text ?? ''),
    );
    if (!phoneNumber) {
      return {
        view: askContact('login.phone', { key: 'bot.login.askPhone' }),
        nextState: state,
      };
    }
    const next: NavState = {
      ...state,
      step: 'login.channel',
      data: { ...state.data, phoneNumber },
    };
    const channels = await this.otp.channelView(ctx);
    if (!channels) {
      return { view: say('otp.none', { key: 'bot.channel.none' }), nextState: null };
    }
    return { view: channels, nextState: next };
  }

  private async channel(
    ctx: ChatContext,
    state: NavState,
    actionId: string | null,
  ): Promise<FlowResult> {
    const channel = this.otp.channelFromAction(actionId);
    if (!channel) {
      return { view: say('otp.pick', { key: 'bot.common.pickOne' }), nextState: state };
    }
    const withChannel: NavState = {
      ...state,
      data: { ...state.data, channel },
    };
    return this.otp.request(ctx, withChannel, channel, 'login.code', (c) =>
      this.api.requestLoginOtp(
        { phoneNumber: state.data.phoneNumber, channel: c },
        { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
      ),
    );
  }

  private async code(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const result = await this.api.verifyLoginOtp(
      { phoneNumber: state.data.phoneNumber, otpCode: (ctx.text ?? '').trim() },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
    );
    if (!result.ok) {
      return {
        view: ask('login.retryCode', { raw: result.msg }, [
          [{ id: ACTIONS.resend, label: { key: 'bot.action.resend' } }],
        ]),
        nextState: state,
      };
    }
    return this.signIn(ctx, result.data?.refreshToken);
  }

  private async password(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const result = await this.api.loginWithPassword(
      { identifier: state.data.identifier, password: (ctx.text ?? '').trim() },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
    );
    if (!result.ok) {
      return {
        view: ask('login.retryPassword', { raw: result.msg }),
        nextState: state,
        // The password was in the chat either way: take it back out.
        deleteIncoming: true,
      };
    }
    // The account has 2FA-by-OTP switched on: continue into the code step.
    if (result.data?.requiresOtp) {
      const channels = await this.otp.channelView(ctx);
      return {
        view: channels ?? say('otp.none', { key: 'bot.channel.none' }),
        nextState: channels
          ? { ...state, step: 'login.channel' }
          : null,
        deleteIncoming: true,
      };
    }
    const signedIn = await this.signIn(ctx, result.data?.refreshToken);
    return { ...signedIn, deleteIncoming: true };
  }

  private async signIn(
    ctx: ChatContext,
    refreshToken: string | undefined,
  ): Promise<FlowResult> {
    if (refreshToken) {
      await this.sessions.save(ctx.platform, ctx.chatId, refreshToken);
    }
    // Say it happened. The menu that follows is attached by the router, so a
    // success is a sentence *and* somewhere to go — not a menu the user has to
    // infer a result from.
    return { view: say('login.done', { key: 'bot.common.signedIn' }), nextState: null };
  }
}
