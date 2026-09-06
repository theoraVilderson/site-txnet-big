import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { ChatAccess } from '../session/chat-access';
import { OtpStep } from './otp.step';
import { ACTIONS, addProofView, ask, say } from './views';

/**
 * Adding an account to the caller's switch group, in the chat (`F-0205`).
 *
 * This is the other half of `F-0210`: `accounts.flow.ts` moves between the
 * accounts one person already holds, and this file is how an account becomes
 * one of them. Membership is **proved, never asserted** (`audit` invariant
 * #4), so the conversation exists to carry exactly one credential — a code
 * sent to the joining account's own phone, or that account's own password —
 * and the caller picks which.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not sign anybody in.** All three routes answer with a group id,
 *   never a token pair. The chat stays signed in as whoever it was, and the
 *   account that just joined is reached afterwards through a switch, which is
 *   itself the point: the credential is spent once, here.
 * - **It does not touch this chat's link.** The code goes to the *other*
 *   account's phone, which is why the OTP step is asked for a deep link rather
 *   than an in-place one (`OtpStep.request`, `inPlace: false`). A chat stays
 *   anchored to exactly one `LinkedBotAccount` (identity invariant #12,
 *   ADR-0014).
 *
 * Every refusal — a wrong code, an account already in someone else's group,
 * the caller's own number — arrives as an already-translated `msg` from
 * `auth-api` and is shown as-is (ADR-0009). Nothing here decides who may join.
 */
@Injectable()
export class AccountAddFlow {
  constructor(
    private readonly api: AuthApiClient,
    private readonly access: ChatAccess,
    private readonly otp: OtpStep,
  ) {}

  /** Which proof, asked before anything is typed. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    // The session is checked here rather than at the end, where the API would
    // refuse anyway: a user who typed a phone number, waited for a code and
    // typed that too, only to be told they were signed out the whole time, has
    // been made to do work for nothing.
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return signedOut();

    return {
      view: addProofView(),
      nextState: { flow: 'accountAdd', step: 'accountAdd.method', data: {} },
    };
  }

  async handle(
    ctx: ChatContext,
    state: NavState,
    actionId: string | null,
  ): Promise<FlowResult> {
    switch (state.step) {
      case 'accountAdd.method':
        if (actionId === ACTIONS.addWithPassword) {
          return {
            view: ask('accountAdd.identifier', { key: 'bot.accounts.addAskIdentifier' }),
            nextState: {
              ...state,
              step: 'accountAdd.identifier',
              // Which branch was taken, because the two are different lengths
              // and a step count that lies is worse than none (`steps.ts`).
              data: { ...state.data, proof: 'password' },
            },
          };
        }
        if (actionId === ACTIONS.addWithOtp) {
          return {
            view: ask('accountAdd.phone', { key: 'bot.accounts.addAskPhone' }),
            nextState: {
              ...state,
              step: 'accountAdd.phone',
              data: { ...state.data, proof: 'otp' },
            },
          };
        }
        return { view: say('accountAdd.pick', { key: 'bot.common.pickOne' }), nextState: state };

      case 'accountAdd.phone':
        return this.phone(ctx, state);

      case 'accountAdd.channel':
        return this.channel(ctx, state, actionId);

      case 'accountAdd.contact':
        return this.otp.submitContact(ctx, state);

      case 'accountAdd.link':
        if (actionId === ACTIONS.linkCheck) return this.otp.checkLink(ctx, state);
        return { view: say('accountAdd.wait', { key: 'bot.common.pickOne' }), nextState: state };

      case 'accountAdd.code':
        if (actionId === ACTIONS.resend) {
          return this.channel(ctx, state, `channel:${state.data.channel}`);
        }
        return this.code(ctx, state);

      case 'accountAdd.identifier':
        return {
          view: ask('accountAdd.password', { key: 'bot.accounts.addAskPassword' }),
          nextState: {
            ...state,
            step: 'accountAdd.password',
            data: { ...state.data, identifier: (ctx.text ?? '').trim() },
          },
        };

      case 'accountAdd.password':
        return this.password(ctx, state);

      default:
        return { view: say('accountAdd.lost', { key: 'bot.common.unknown' }), nextState: null };
    }
  }

  /**
   * The number of the account being added — typed, never shared.
   *
   * `askContact` is wrong on this screen and the difference is the whole
   * feature: the platform's contact button sends *this* user's own number, and
   * this user's own account is the one already signed in. `auth-api` refuses
   * it (`accountSwitch.sameAccount`), but offering a button whose only outcome
   * is that refusal is a worse screen than a plain question.
   */
  private async phone(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const phoneNumber = (ctx.text ?? '').trim();
    if (!phoneNumber) {
      return {
        view: ask('accountAdd.phone', { key: 'bot.accounts.addAskPhone' }),
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
        step: 'accountAdd.channel',
        data: { ...state.data, phoneNumber },
      },
    };
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
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return signedOut();

    const withChannel: NavState = { ...state, data: { ...state.data, channel } };
    return this.otp.request(
      ctx,
      withChannel,
      channel,
      'accountAdd.code',
      (c) =>
        this.api.requestAddOtp(
          { phoneNumber: state.data.phoneNumber, channel: c },
          { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform, accessToken },
        ),
      // The code is going to somebody else's phone — see the class comment.
      { inPlace: false },
    );
  }

  private async code(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return signedOut();

    const result = await this.api.addAccountByOtp(
      { phoneNumber: state.data.phoneNumber, otpCode: (ctx.text ?? '').trim() },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform, accessToken },
    );
    if (!result.ok) {
      // A mistyped code is one character, not a conversation: stay on the step
      // with a way to ask for a new one, exactly as signing in does.
      return {
        view: ask('accountAdd.retryCode', { raw: result.msg }, [
          [{ id: ACTIONS.resend, label: { key: 'bot.action.resend' } }],
        ]),
        nextState: state,
      };
    }
    return added();
  }

  private async password(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    // The password is in the chat either way, so it is taken back out on every
    // path out of this method — including the one where the session is gone.
    if (!accessToken) return { ...signedOut(), deleteIncoming: true };

    const result = await this.api.addAccountByPassword(
      { identifier: state.data.identifier, password: (ctx.text ?? '').trim() },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform, accessToken },
    );
    if (!result.ok) {
      return {
        view: ask('accountAdd.retryPassword', { raw: result.msg }),
        nextState: state,
        deleteIncoming: true,
      };
    }
    return { ...added(), deleteIncoming: true };
  }
}

/**
 * Done. The sentence says what changed *and* what it now makes possible —
 * a group with nothing said about switching is a setting the user cannot see
 * the effect of. The menu the router attaches leads back to the list.
 */
function added(): FlowResult {
  return {
    view: say('accountAdd.done', { key: 'bot.accounts.added' }),
    nextState: null,
  };
}

/** Same shape as the switch flow's: the router attaches the guest menu. */
function signedOut(): FlowResult {
  return {
    view: say('accountAdd.signedOut', { key: 'bot.common.notSignedIn' }),
    nextState: null,
  };
}
