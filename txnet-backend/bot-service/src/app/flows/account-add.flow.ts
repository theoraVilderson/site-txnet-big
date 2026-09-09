import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { AccountSwitcher } from '../session/account-switcher';
import { ChatAccess } from '../session/chat-access';
import { OtpStep } from './otp.step';
import { PhoneNumbers } from './phone-number';
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
 * - **It does not sign anybody in.** All three routes answer with a group id
 *   and the joining account's `userId`, never a token pair. Reaching that
 *   account is a separate, credential-free switch — which this flow then makes
 *   on the user's behalf, because an account you added and are not on is a
 *   setting, not a capability. The proof is still spent exactly once, here.
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
    private readonly switcher: AccountSwitcher,
    private readonly phones: PhoneNumbers,
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
    const phoneNumber = this.phones.read(ctx.text ?? '');
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
    return this.landOn(ctx, accessToken, result.data.userId);
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
    // The password leaves the chat whatever the switch afterwards answers:
    // the message is already in the history, and a failed convenience is no
    // reason to leave a credential sitting in it.
    return { ...(await this.landOn(ctx, accessToken, result.data.userId)), deleteIncoming: true };
  }

  /**
   * Be the account that just joined.
   *
   * The old behaviour ended here with a message and the main menu, and the
   * user had to open the accounts list and tap the account they had just
   * proved ownership of — the proof had already answered the only question a
   * switch asks, so the tap was ceremony.
   *
   * A refusal is not reported as one. Cross-tenant, deactivated, a session
   * revoked between the two calls: the add still happened, the group still
   * changed, and telling the user it failed would be false. They land where
   * they were, with the message that says the account is now in the list.
   */
  private async landOn(
    ctx: ChatContext,
    accessToken: string,
    userId: string,
  ): Promise<FlowResult> {
    // The add's own token, not a fresh one. An access token lives fifteen
    // minutes and the add consumed none of it, so refreshing again here would
    // buy nothing and cost a second rotation — one more chance to drop the
    // only refresh token this chat has.
    const switched = await this.switcher.switchTo(ctx, accessToken, userId);
    if (!switched.ok) return added();

    return {
      view: say('accountAdd.switched', {
        key: 'bot.accounts.switched',
        values: { name: switched.fullName },
      }),
      nextState: null,
    };
  }
}

/**
 * Done, but still on the old account.
 *
 * This is now the *failure* wording — reached only when the switch after a
 * successful add was refused. The add itself stands: the account is in the
 * group and one tap on the accounts list reaches it, which is exactly what
 * this key already says.
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
