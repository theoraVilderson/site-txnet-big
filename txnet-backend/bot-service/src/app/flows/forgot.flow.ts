import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import {
  callContextOf,
  ChatContext,
  FlowResult,
  NavState,
} from '../conversation/nav.types';
import { BotSessionStore } from '../session/bot-session.store';
import { OtpStep } from './otp.step';
import { PhoneNumbers } from './phone-number';
import { ACTIONS, ask, askContact, say } from './views';

/**
 * Resetting a forgotten password from the chat.
 *
 * The reset revokes every session the account had (`identity` invariant #3) and
 * hands back one new session for the device that performed it — here, this
 * chat. So a successful reset leaves the user signed in *in the bot* and signed
 * out everywhere else, which is the same promise the panel makes.
 */
@Injectable()
export class ForgotFlow {
  constructor(
    private readonly api: AuthApiClient,
    private readonly otp: OtpStep,
    private readonly sessions: BotSessionStore,
    private readonly phones: PhoneNumbers,
  ) {}

  start(): FlowResult {
    return {
      view: askContact('forgot.phone', { key: 'bot.login.askPhone' }),
      nextState: { flow: 'forgot', step: 'forgot.phone', data: {} },
    };
  }

  async handle(
    ctx: ChatContext,
    state: NavState,
    actionId: string | null,
  ): Promise<FlowResult> {
    switch (state.step) {
      case 'forgot.phone': {
        const phoneNumber = this.phones.read(
          ctx.contact?.phone_number ?? (ctx.text ?? ''),
        );
        if (!phoneNumber) {
          return {
            view: askContact('forgot.phone', { key: 'bot.login.askPhone' }),
            nextState: state,
          };
        }
        const channels = await this.otp.channelView(ctx);
        if (!channels) {
          return { view: say('otp.none', { key: 'bot.channel.none' }), nextState: null };
        }
        return {
          view: channels,
          nextState: {
            ...state,
            step: 'forgot.channel',
            data: { ...state.data, phoneNumber },
          },
        };
      }

      case 'forgot.channel': {
        const channel = this.otp.channelFromAction(actionId);
        if (!channel) {
          return { view: say('otp.pick', { key: 'bot.common.pickOne' }), nextState: state };
        }
        return this.otp.request(ctx, state, channel, 'forgot.code', (c) =>
          this.api.forgotPassword(
            { phoneNumber: state.data.phoneNumber, channel: c },
            callContextOf(ctx),
          ),
        );
      }

      case 'forgot.contact':
        return this.otp.submitContact(ctx, state);

      case 'forgot.link':
        if (actionId === ACTIONS.linkCheck) return this.otp.checkLink(ctx, state);
        return { view: say('forgot.wait', { key: 'bot.common.pickOne' }), nextState: state };

      case 'forgot.code': {
        const verified = await this.api.verifyForgotOtp(
          { phoneNumber: state.data.phoneNumber, otpCode: (ctx.text ?? '').trim() },
          callContextOf(ctx),
        );
        if (!verified.ok || !verified.data?.resetToken) {
          return { view: ask('forgot.retryCode', { raw: verified.msg }), nextState: state };
        }
        return {
          view: ask('forgot.password', { key: 'bot.forgot.askPassword' }),
          nextState: {
            ...state,
            step: 'forgot.password',
            data: { ...state.data, resetToken: verified.data.resetToken },
          },
        };
      }

      case 'forgot.password': {
        const result = await this.api.resetPassword(
          {
            resetToken: state.data.resetToken,
            newPassword: (ctx.text ?? '').trim(),
          },
          callContextOf(ctx),
        );
        if (!result.ok) {
          return {
            view: ask('forgot.retryPassword', { raw: result.msg }),
            nextState: state,
            deleteIncoming: true,
          };
        }
        if (result.data?.refreshToken) {
          await this.sessions.save(
            ctx.integration,
            ctx.chatId,
            result.data.refreshToken,
          );
        }
        return {
          view: say('forgot.done', { key: 'bot.forgot.done' }),
          nextState: null,
          deleteIncoming: true,
        };
      }

      default:
        return { view: say('forgot.lost', { key: 'bot.common.unknown' }), nextState: null };
    }
  }
}
