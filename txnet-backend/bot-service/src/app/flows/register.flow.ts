import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotSessionStore } from '../session/bot-session.store';
import { OtpStep } from './otp.step';
import { ACTIONS, ask, askContact, say } from './views';

/**
 * Creating an account from the chat.
 *
 * The order is deliberate: the number first (a shared contact gives it *and*
 * the proof that links this messenger), then the profile, then the password,
 * then the code. No `user` row exists until the code is verified — that is
 * `identity`'s invariant #11 and this flow neither knows nor bypasses it; it
 * simply calls `register` and then `register/verify-phone`.
 *
 * The password is typed in the chat and the message deleted the moment it has
 * been used (ADR-0011, decision 3). It is never written to Redis.
 */
@Injectable()
export class RegisterFlow {
  constructor(
    private readonly api: AuthApiClient,
    private readonly otp: OtpStep,
    private readonly sessions: BotSessionStore,
  ) {}

  start(): FlowResult {
    return {
      view: askContact('register.phone', { key: 'bot.login.askPhone' }),
      nextState: { flow: 'register', step: 'register.phone', data: {} },
    };
  }

  async handle(
    ctx: ChatContext,
    state: NavState,
    actionId: string | null,
  ): Promise<FlowResult> {
    switch (state.step) {
      case 'register.phone': {
        const phoneNumber = ctx.contact?.phone_number ?? (ctx.text ?? '').trim();
        if (!phoneNumber) {
          return {
            view: askContact('register.phone', { key: 'bot.login.askPhone' }),
            nextState: state,
          };
        }
        return {
          view: ask('register.name', { key: 'bot.register.askName' }),
          nextState: {
            ...state,
            step: 'register.name',
            data: { ...state.data, phoneNumber },
          },
        };
      }

      case 'register.name':
        return {
          view: ask('register.username', { key: 'bot.register.askUsername' }),
          nextState: {
            ...state,
            step: 'register.username',
            data: { ...state.data, fullName: (ctx.text ?? '').trim() },
          },
        };

      case 'register.username': {
        const withUsername: NavState = {
          ...state,
          data: { ...state.data, username: (ctx.text ?? '').trim() },
        };
        const channels = await this.otp.channelView(ctx);
        if (!channels) {
          return { view: say('otp.none', { key: 'bot.channel.none' }), nextState: null };
        }
        return { view: channels, nextState: { ...withUsername, step: 'register.channel' } };
      }

      // The channel is chosen *before* the password on purpose: registration
      // is a single call that carries both, so asking for the password last
      // means it is used in the same request it arrives in and never has to be
      // stored anywhere.
      case 'register.channel': {
        const channel = this.otp.channelFromAction(actionId);
        if (!channel) {
          return { view: say('otp.pick', { key: 'bot.common.pickOne' }), nextState: state };
        }
        return {
          view: ask('register.password', { key: 'bot.register.askPassword' }),
          nextState: {
            ...state,
            step: 'register.password',
            data: { ...state.data, channel },
          },
        };
      }

      case 'register.password':
        return this.password(ctx, state);

      case 'register.contact':
        return this.otp.submitContact(ctx, state);

      case 'register.link':
        if (actionId === ACTIONS.linkCheck) return this.otp.checkLink(ctx, state);
        return { view: say('register.wait', { key: 'bot.common.pickOne' }), nextState: state };

      case 'register.code':
        return this.code(ctx, state);

      default:
        return { view: say('register.lost', { key: 'bot.common.unknown' }), nextState: null };
    }
  }

  /**
   * The password arrives, is spent on the `register` call, and is gone: it is
   * held in a local for the length of this request and never reaches Redis (see
   * `ConversationStore`, which refuses to write it even if a future step tries).
   * The message it came in is deleted by the dispatcher.
   */
  private async password(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const password = (ctx.text ?? '').trim();
    if (!password) {
      return {
        view: ask('register.password', { key: 'bot.register.askPassword' }),
        nextState: state,
      };
    }
    const channel = state.data.channel as 'sms' | 'telegram' | 'bale';
    const result = await this.otp.request(ctx, state, channel, 'register.code', (c) =>
      this.api.register(
        {
          fullName: state.data.fullName,
          username: state.data.username,
          phoneNumber: state.data.phoneNumber,
          password,
          channel: c,
        },
        { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
      ),
    );
    return { ...result, deleteIncoming: true };
  }

  private async code(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const result = await this.api.verifyPhone(
      { phoneNumber: state.data.phoneNumber, otpCode: (ctx.text ?? '').trim() },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
    );
    if (!result.ok) {
      return { view: ask('register.retryCode', { raw: result.msg }), nextState: state };
    }
    if (result.data?.refreshToken) {
      await this.sessions.save(ctx.platform, ctx.chatId, result.data.refreshToken);
    }
    // Six questions deserve an answer. The router adds the member menu below
    // it, so the end of registration is a result and a next step in one message.
    return { view: say('register.done', { key: 'bot.register.done' }), nextState: null };
  }
}
