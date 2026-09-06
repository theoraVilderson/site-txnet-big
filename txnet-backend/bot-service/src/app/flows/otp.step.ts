import { Injectable, Logger } from '@nestjs/common';
import { BotPlatform, BotView } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import {
  ApiResult,
  OtpChannelDescriptor,
  OtpChannelName,
  OtpRequestResult,
} from '../auth-api/auth-api.types';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { ACTIONS, ask, say, view } from './views';

export const CHANNEL_ACTION_PREFIX = 'channel:';

/**
 * The step every flow shares: **where should the code go?**
 *
 * This is what the bot exists to make possible — in the Telegram bot the code
 * can arrive by SMS or in Bale, and in the Bale bot by SMS or in Telegram. None
 * of that is a bot rule: the channels come from `GET /auth/otp/channels`, and
 * an unlinked messenger answers with the ordinary `linkRequired` shape
 * (`F-0202`/`F-0203`). The only thing this class adds is which order to offer
 * them in, and the in-place link below.
 *
 * When the chosen messenger *is the chat you are already in*, there is no point
 * sending the user out through a deep link and back: the bot replays the link
 * conversation in place — `link/resolve` binds the chat, the user taps "share
 * my number", `link/contact` proves it. A flow whose code is going to a number
 * that is *not* the person in this chat passes `inPlace: false` and gets the
 * deep link instead (see `request`).
 *
 * Signing in no longer arrives here at all (ADR-0012): a chat that holds a
 * contact-verified link is a credential, so `LoginFlow` trades it for a session
 * before any of this runs. What is left on this path is a code going somewhere
 * the user is not — an SMS, or a chat belonging to a number they typed.
 */
@Injectable()
export class OtpStep {
  private readonly logger = new Logger(OtpStep.name);

  constructor(private readonly api: AuthApiClient) {}

  /**
   * The channel screen, or `null` when this environment offers nothing — an
   * SMS-off, messenger-off deployment must say so rather than hang.
   */
  async channelView(ctx: ChatContext): Promise<BotView | null> {
    const result = await this.api.otpChannels({
      chatId: ctx.chatId,
      lang: ctx.lang,
      platform: ctx.platform,
    });
    const channels = result.ok ? (result.data?.channels ?? []) : [];
    if (!channels.length) return null;

    const ordered = orderForPlatform(ctx.platform, channels);
    return ask(
      'otp.channels',
      { key: 'bot.login.pickChannel' },
      ordered.map((descriptor) => [
        {
          id: `${CHANNEL_ACTION_PREFIX}${descriptor.channel}`,
          label: channelLabel(ctx.platform, descriptor.channel),
        },
      ]),
    );
  }

  /** Reads a channel choice back off whatever the user tapped or typed. */
  channelFromAction(actionId: string | null): OtpChannelName | null {
    if (!actionId?.startsWith(CHANNEL_ACTION_PREFIX)) return null;
    const name = actionId.slice(CHANNEL_ACTION_PREFIX.length);
    return ['sms', 'telegram', 'bale'].includes(name)
      ? (name as OtpChannelName)
      : null;
  }

  /**
   * Asks `auth-api` for a code on `channel` and turns the answer into the next
   * screen. `send` is the flow's own call — login, register or forgot — so the
   * three flows share this handling without this class knowing which is which.
   */
  async request(
    ctx: ChatContext,
    state: NavState,
    channel: OtpChannelName,
    codeStep: string,
    send: (channel: OtpChannelName) => Promise<ApiResult<OtpRequestResult>>,
    options: { inPlace?: boolean } = {},
  ): Promise<FlowResult> {
    const result = await send(channel);
    if (!result.ok) {
      return { view: say('otp.failed', { raw: result.msg }), nextState: state };
    }

    const data = result.data;
    if (!data?.linkRequired) {
      return {
        view: ask('otp.code', { key: 'bot.login.askCode' }),
        nextState: { ...state, step: codeStep },
      };
    }

    const linkPlatform = (data.platform ?? channel) as BotPlatform;
    const next: NavState = {
      ...state,
      step: codeStep,
      linkToken: data.linkToken,
      linkPlatform,
    };

    // The messenger the code should arrive in is the one the user is talking
    // to: link it here, in this chat, instead of sending them on a round trip.
    //
    // `inPlace: false` switches that off, and one caller needs it: adding an
    // account (`F-0205`) sends the code to *someone else's* number, so linking
    // this chat would either move the chat's own link or — because identity
    // refuses that (invariant #12, `takenByAnotherAccount`) — walk the user
    // through sharing a contact card that cannot possibly match. The deep link
    // is the honest screen there: the account being added proves itself from
    // its own chat.
    if (options.inPlace !== false && linkPlatform === ctx.platform && data.linkToken) {
      const resolved = await this.api.linkResolve(
        {
          platform: ctx.platform,
          chatId: ctx.chatId,
          startToken: data.linkToken,
        },
        { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
      );
      if (!resolved.ok || !resolved.data) {
        return { view: say('link.failed', { raw: resolved.msg }), nextState: next };
      }
      if (resolved.data.needsContact) {
        return {
          view: {
            id: 'link.contact',
            body: { key: `otp.botLink.${resolved.data.messageKey}` },
            actions: [
              [
                {
                  id: ACTIONS.shareContact,
                  kind: 'contact',
                  label: { key: 'bot.action.shareContact' },
                },
              ],
            ],
          },
          nextState: { ...next, step: `${state.flow}.contact` },
        };
      }
      // Already linked from this chat: the code is on its way.
      return {
        view: ask('otp.code', { key: 'bot.login.askCode' }),
        nextState: next,
      };
    }

    // The other messenger: hand over its deep link and wait to be told.
    return {
      view: view(
        'link.other',
        {
          key: 'bot.link.required',
          values: { platform: platformName(linkPlatform) },
        },
        [
          [
            {
              id: ACTIONS.linkOpen,
              kind: 'url',
              url: data.deepLink ?? '',
              label: {
                key: 'bot.link.open',
                values: { platform: platformName(linkPlatform) },
              },
            },
          ],
          [{ id: ACTIONS.linkCheck, label: { key: 'bot.link.check' } }],
        ],
      ),
      nextState: { ...next, step: `${state.flow}.link` },
    };
  }

  /** "I have done that" on a cross-messenger link. */
  async checkLink(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    if (!state.linkToken) {
      return { view: say('link.expired', { key: 'bot.common.tryAgain' }), nextState: null };
    }
    const status = await this.api.linkStatus(
      { linkToken: state.linkToken },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
    );
    const linked = status.ok && status.data?.state === 'linked';
    if (!linked) {
      const failureKey = status.data?.failureKey;
      return {
        view: view(
          'link.waiting',
          failureKey
            ? { key: failureKey }
            : {
                key: 'bot.link.waiting',
                values: { platform: platformName(state.linkPlatform) },
              },
          [[{ id: ACTIONS.linkCheck, label: { key: 'bot.link.check' } }]],
        ),
        nextState: state,
      };
    }
    return {
      view: ask('otp.code', { key: 'bot.login.askCode' }),
      nextState: { ...state, step: `${state.flow}.code` },
    };
  }

  /**
   * The contact the user shared while linking in place. The proof itself is
   * checked in `identity` (invariant #12) — this only renders the outcome.
   */
  async submitContact(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    if (!ctx.contact) {
      return { view: say('link.noContact', { key: 'bot.common.pickOne' }), nextState: state };
    }
    const outcome = await this.api.linkContact(
      {
        platform: ctx.platform,
        chatId: ctx.chatId,
        senderId: ctx.senderId ?? '',
        contact: ctx.contact,
      },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform },
    );
    if (!outcome.ok || !outcome.data) {
      return { view: say('link.failed', { raw: outcome.msg }), nextState: state };
    }
    if (outcome.data.state !== 'linked') {
      this.logger.log(
        `${ctx.platform}: in-place link failed for chat=${ctx.chatId} (${outcome.data.failureKey ?? 'unknown'})`,
      );
      return {
        view: say('link.rejected', {
          key: `otp.botLink.${outcome.data.messageKey}`,
        }),
        nextState: null,
      };
    }
    return {
      view: ask('otp.code', { key: 'bot.login.askCode' }),
      nextState: { ...state, step: `${state.flow}.code` },
    };
  }
}

/**
 * Which order to offer the channels in: this platform first (a code in a
 * messenger you already have open beats waiting for an SMS), then SMS, then
 * the other messenger.
 */
export function orderForPlatform(
  platform: BotPlatform,
  channels: OtpChannelDescriptor[],
): OtpChannelDescriptor[] {
  const rank = (c: OtpChannelDescriptor) =>
    c.channel === platform ? 0 : c.channel === 'sms' ? 1 : 2;
  return [...channels].sort((a, b) => rank(a) - rank(b));
}

/**
 * Every channel is named after itself. There used to be a "here, in this chat"
 * label when the channel matched the chat's own platform, and it was wrong
 * twice over (ADR-0012): the code goes to whichever chat owns the **typed**
 * number, which is only this one by coincidence, and when it *was* this one
 * the round trip proved nothing that `bots/session` does not now prove in one
 * tap. The channel itself stays — a second account of yours, linked to another
 * chat on this same platform, is a real destination.
 */
function channelLabel(_platform: BotPlatform, channel: OtpChannelName) {
  return { key: `bot.channel.${channel}` };
}

function platformName(platform?: BotPlatform): string {
  return platform === 'bale' ? 'Bale' : 'Telegram';
}
