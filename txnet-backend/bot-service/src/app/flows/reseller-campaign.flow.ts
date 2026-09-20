import { BotPlatform } from '@txnet-backend/messenger';
import { Injectable } from '@nestjs/common';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import {
  CampaignAudience,
  CampaignChannel,
  CampaignStatus,
  NotificationApiClient,
} from '../notification-api/notification-api.client';
import { ChatAccess } from '../session/chat-access';
import { TenantApiClient } from '../tenant-api/tenant-api.client';
import {
  ACTIONS,
  CAMPAIGN_OPEN_PREFIX,
  CAMPAIGN_SEGMENT_PREFIX,
  CAMPAIGN_SEND_PREFIX,
  CAMPAIGN_STATUS_PREFIX,
  campaignAskTextView,
  campaignConfirmView,
  campaignListView,
  campaignSegmentsView,
  campaignStatusView,
  say,
} from './views';

/** How many past broadcasts one screen holds — a chat list, not a report. */
export const RECENT_CAMPAIGNS = 5;

/** How far back "recently joined" reaches, in days. */
const NEW_CUSTOMER_DAYS = 30;

/**
 * The segments a chat may pick from, each one a composition of
 * `notification`'s own audience filter (`campaign-admin.schema.ts`, F-035-d).
 *
 * **Compositions, never an extension.** That schema is `strict`, the fan-out
 * reads exactly its keys, and a new key belongs in both of them before it
 * belongs on a button here — which is the rule that file states. What the bot
 * owns is that a chat cannot hold a filter builder, so the choice is a short
 * list of the segments a reseller actually broadcasts to.
 *
 * The filter is resolved here, from the key the button carried, and never sent
 * on the button itself: a payload is input, and an audience that arrived as
 * input is an audience a caller can write.
 */
const SEGMENTS: Record<string, { label: string; audience: (now: Date) => CampaignAudience }> = {
  all: { label: BotKeys.action.campaignSegAll, audience: () => ({}) },
  active: { label: BotKeys.action.campaignSegActive, audience: () => ({ statuses: ['active'] }) },
  new30: {
    label: BotKeys.action.campaignSegNew,
    audience: (now) => ({
      registeredFrom: new Date(now.getTime() - NEW_CUSTOMER_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    }),
  },
};

/**
 * Which line a campaign written in this chat goes out on. An exhaustive
 * `Record` over the platforms (C-07's habit), so a third messenger is a
 * compile error rather than a campaign drafted with no channel.
 */
const CHANNEL: Record<BotPlatform, CampaignChannel> = {
  telegram: 'telegram_bot',
  bale: 'bale_bot',
};

/**
 * Where a broadcast is, as one whole sentence per status (C-07): an exhaustive
 * `Record` over `notification`'s `CampaignStatus`. Each key's text carries
 * `{{sent}}` and `{{failed}}`, so no key is ever interpolated into another
 * key's value — an interpolated key renders as itself.
 */
const STATUS_KEY: Record<CampaignStatus, string> = {
  draft: BotKeys.campaign.statusDraft,
  sending: BotKeys.campaign.statusSending,
  completed: BotKeys.campaign.statusCompleted,
  stopped: BotKeys.campaign.statusStopped,
};

/**
 * A reseller's own bulk message, drafted and sent inside the chat (`F-313-b`,
 * spec F-313): pick a segment, see how many it reaches, write it, confirm, and
 * watch it go.
 *
 * **The flow only.** The audience shape, the draft, the count, the queue and
 * every refusal are `notification`'s (F-313-d over F-035-c/d), the pace the
 * send keeps is `messenger`'s (F-313-a, ADR-0066), and whether this caller may
 * start one at all is the door's (F-311-e). This file owns the order of the
 * screens, the few segments a chat can offer, and nothing else — which is what
 * `bot-app/contract.md` "the decision belongs to" requires.
 *
 * **The reseller is the bot's, never the session's**: `ctx.integration.tenantId`
 * (F-320) is what every call names in its path, because the owner signs in in
 * their own platform tenant (ADR-0059 (6), F-061-i) and the session therefore
 * never names the reseller whose bot this is.
 *
 * **The draft is a row, not conversation state** (ADR-0010). The moment the
 * message is written it exists in `notification`; this flow keeps its id. A
 * chat abandoned on the confirmation has left a draft behind — something the
 * reseller can find again — rather than a half-sent broadcast or lost work.
 */
@Injectable()
export class ResellerCampaignFlow {
  constructor(
    private readonly notifications: NotificationApiClient,
    private readonly tenant: TenantApiClient,
    private readonly access: ChatAccess,
  ) {}

  /** Unset `NOTIFICATION_API_BASE_URL` means no row on the reseller menu at all. */
  get isConfigured(): boolean {
    return this.notifications.isConfigured;
  }

  /**
   * The way in, from the reseller panel's menu.
   *
   * `canWrite` is re-read here rather than carried from the menu row, for the
   * reason the block button is (ADR-0033, `tenant/rules.md`): a **suspended**
   * reseller still reads what it has sent and starts nothing new. It gets the
   * list, which is the screen it may actually use. A door that does not answer
   * is treated the same way — offering the segments would be a refusal wearing
   * a button.
   */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const verdict = await this.tenant.access(ctx.integration.tenantId, { lang: ctx.lang, accessToken });
    if (!verdict.ok || !verdict.data?.canWrite) return this.list(ctx, accessToken, true);

    return {
      view: campaignSegmentsView(segments()),
      nextState: { flow: 'campaign', step: 'campaign.segment', data: {} },
    };
  }

  async handle(ctx: ChatContext, state: NavState, actionId: string | null): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    if (actionId === ACTIONS.campaignRecent) return this.list(ctx, accessToken, false);

    if (actionId?.startsWith(CAMPAIGN_SEGMENT_PREFIX)) {
      return this.count(ctx, accessToken, actionId.slice(CAMPAIGN_SEGMENT_PREFIX.length));
    }
    if (actionId?.startsWith(CAMPAIGN_SEND_PREFIX)) {
      const id = actionId.slice(CAMPAIGN_SEND_PREFIX.length);
      // The tap that sends must be the tap on the screen that asked. A stale
      // keyboard — the confirmation of an earlier draft, still three messages
      // up — shows that campaign instead of starting it, the same two-prefix
      // rule `rblock:` follows for blocking a customer.
      return state.step === 'campaign.confirm' && state.data.id === id
        ? this.send(ctx, accessToken, id)
        : this.status(ctx, accessToken, id);
    }
    if (actionId?.startsWith(CAMPAIGN_STATUS_PREFIX)) {
      return this.status(ctx, accessToken, actionId.slice(CAMPAIGN_STATUS_PREFIX.length));
    }
    if (actionId?.startsWith(CAMPAIGN_OPEN_PREFIX)) {
      return this.status(ctx, accessToken, actionId.slice(CAMPAIGN_OPEN_PREFIX.length));
    }

    // Free text on the "write your message" screen is the message. Anywhere
    // else in this flow it is an answer to a screen that asked nothing — the
    // same rule the customer list applies to its search box.
    if (actionId === null && state.step === 'campaign.text') return this.draft(ctx, state, accessToken);

    return { view: say('campaign.pickOne', { key: BotKeys.common.pickOne }), nextState: state };
  }

  /**
   * How many customers that segment reaches, before a word is written.
   *
   * `notification` answers it with the fan-out's own query (F-313-d), so the
   * number shown is the number of recipient rows the send will write — up to
   * whoever signs up in between, which is why the screen says *about*.
   *
   * A segment nobody is in ends here rather than at the confirmation: writing
   * a message for no one is work the bot can spare, and the screen it lands on
   * is the segments again.
   */
  private async count(ctx: ChatContext, accessToken: string, key: string): Promise<FlowResult> {
    const segment = SEGMENTS[key];
    if (!segment) return { view: campaignSegmentsView(segments()), nextState: this.onSegments() };

    const counted = await this.notifications.audienceCount(
      ctx.integration.tenantId,
      segment.audience(new Date()),
      this.callFor(ctx, accessToken),
    );
    if (!counted.ok || !counted.data) {
      return { view: say('campaign.count.failed', { raw: counted.msg }), nextState: null };
    }
    if (counted.data.count === 0) {
      return { view: campaignSegmentsView(segments(), BotKeys.campaign.empty), nextState: this.onSegments() };
    }

    return {
      view: campaignAskTextView(counted.data.count),
      nextState: {
        flow: 'campaign',
        step: 'campaign.text',
        data: { segment: key, count: String(counted.data.count) },
      },
    };
  }

  /**
   * The message, as a draft in `notification` (ADR-0010: a commitment is a row
   * in the domain that owns it, the moment it becomes one).
   *
   * Nothing about the text is judged here. Its length, its channel's
   * availability and whether this reseller may draft at all are rules that
   * already exist on the other side, and a second copy in the bot is what
   * ADR-0009 forecloses — a refusal arrives as `notification`'s own sentence.
   *
   * The audience is resolved from the **remembered** segment, so the message
   * goes to the segment whose count the reseller was shown.
   */
  private async draft(ctx: ChatContext, state: NavState, accessToken: string): Promise<FlowResult> {
    const segment = SEGMENTS[state.data.segment];
    const body = (ctx.text ?? '').trim();
    if (!segment) return { view: campaignSegmentsView(segments()), nextState: this.onSegments() };
    if (!body) return { view: campaignAskTextView(Number(state.data.count) || 0), nextState: state };

    const drafted = await this.notifications.draft(
      ctx.integration.tenantId,
      { channel: CHANNEL[ctx.platform], messageBody: body, audience: segment.audience(new Date()) },
      this.callFor(ctx, accessToken),
    );
    if (!drafted.ok || !drafted.data) {
      return { view: say('campaign.draft.failed', { raw: drafted.msg }), nextState: null };
    }

    return {
      view: campaignConfirmView(drafted.data, Number(state.data.count) || 0),
      nextState: {
        flow: 'campaign',
        step: 'campaign.confirm',
        data: { ...state.data, id: drafted.data.id },
      },
    };
  }

  /**
   * Start it. `notification` flips the draft to `sending` and `worker-service`
   * fans it out (F-035-d), paced by the bot's own outbound ceiling so a
   * campaign yields to the people in the middle of a conversation (F-313-a/c).
   */
  private async send(ctx: ChatContext, accessToken: string, id: string): Promise<FlowResult> {
    const started = await this.notifications.start(ctx.integration.tenantId, id, this.callFor(ctx, accessToken));
    if (!started.ok || !started.data) {
      return { view: say('campaign.send.failed', { raw: started.msg }), nextState: null };
    }
    return this.watching(started.data);
  }

  /** Where it has got to, re-read — the refresh button is how a chat watches. */
  private async status(ctx: ChatContext, accessToken: string, id: string): Promise<FlowResult> {
    const found = await this.notifications.campaign(ctx.integration.tenantId, id, this.callFor(ctx, accessToken));
    if (!found.ok || !found.data) {
      return { view: say('campaign.status.failed', { raw: found.msg }), nextState: null };
    }
    return this.watching(found.data);
  }

  /** What this reseller has sent, newest first — and the whole screen a suspended one gets. */
  private async list(ctx: ChatContext, accessToken: string, readOnly: boolean): Promise<FlowResult> {
    const listed = await this.notifications.list(
      ctx.integration.tenantId,
      { page: 1, pageSize: RECENT_CAMPAIGNS },
      this.callFor(ctx, accessToken),
    );
    if (!listed.ok || !listed.data) {
      return { view: say('campaign.list.failed', { raw: listed.msg }), nextState: null };
    }
    return {
      view: campaignListView(listed.data.items, readOnly),
      nextState: { flow: 'campaign', step: 'campaign.list', data: {} },
    };
  }

  private watching(campaign: { id: string; status: CampaignStatus; sentCount: number; failedCount: number }): FlowResult {
    return {
      view: campaignStatusView(campaign, STATUS_KEY[campaign.status] ?? BotKeys.common.tryAgain),
      nextState: { flow: 'campaign', step: 'campaign.sent', data: { id: campaign.id } },
    };
  }

  private onSegments(): NavState {
    return { flow: 'campaign', step: 'campaign.segment', data: {} };
  }

  /** Every `notification` call from this flow, in one shape. */
  private callFor(ctx: ChatContext, accessToken: string) {
    return { lang: ctx.lang, accessToken };
  }

  private signedOut(): FlowResult {
    return { view: say('reseller.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}

/** The segment buttons, in the order a reseller reads them. */
function segments(): { key: string; label: string }[] {
  return Object.entries(SEGMENTS).map(([key, s]) => ({ key, label: s.label }));
}
