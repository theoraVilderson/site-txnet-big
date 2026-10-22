import { Injectable } from '@nestjs/common';
import { BotAction, BotText } from '@txnet-backend/messenger';
import { BillingApiClient, BillingCallContext } from '../billing-api/billing-api.client';
import type { ChatPrizeService, ChatRewardTarget } from '../billing-api/engagement.types';
import { ChatContext, FlowResult } from '../conversation/nav.types';
import { BotKey, BotKeys } from '../locale/bot-keys';
import { LocaleService } from '../locale/locale.service';
import { ChatAccess } from '../session/chat-access';
import { bytesLabel, serviceNameOf, timeLeftOf } from './service-words';
import { say, view } from './views';

/** Billing's `RewardTargetRejection`, each with its sentence. */
const REFUSAL_KEYS: Record<string, BotKey> = BotKeys.prizeService.refusals;

/** `prz:o` opens the list, `prz:a` is automatic, `prz:g:<grantId>` a service (42 bytes): each names what it does, so none needs state. */
export const PRIZE_SERVICE_ACTION_PREFIX = 'prz:';
const OPEN = `${PRIZE_SERVICE_ACTION_PREFIX}o`;
const AUTOMATIC = `${PRIZE_SERVICE_ACTION_PREFIX}a`;
const GRANT = `${PRIZE_SERVICE_ACTION_PREFIX}g:`;

/**
 * The wheel's and the lottery list's «🎁 سرویس جایزه» row (F-707-t): only when
 * the user has two services or more a prize can reach, as the panel shows its
 * picker. A failed read costs the row, never the screen it sits on.
 */
export async function prizeServiceRows(billing: BillingApiClient, call: BillingCallContext): Promise<BotAction[][]> {
  const read = await billing.rewardTarget(call);
  if (!read.ok || !read.data || read.data.services.length < 2) return [];
  return [[{ id: OPEN, label: { key: BotKeys.action.prizeService } }]];
}

/**
 * The prize service in the chat (F-707-t, billing F-707-r): which service GB
 * and days won on the wheel or in a lottery are added to — the panel's own
 * `/api/billing/reward-target`, so the chat and the panel hold one choice.
 *
 * The bot keeps nothing: the list is billing's, a tap saves and the chat says
 * what billing answered. Each answer ends the conversation.
 */
@Injectable()
export class PrizeServiceFlow {
  constructor(
    private readonly billing: BillingApiClient,
    private readonly access: ChatAccess,
    private readonly locale: LocaleService,
  ) {}

  async tap(ctx: ChatContext, actionId: string): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return { view: say('prizeService.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
    const call: BillingCallContext = { lang: ctx.lang, accessToken, platform: ctx.platform, botTenantId: ctx.integration.tenantId };

    if (actionId === AUTOMATIC) return this.choose(ctx, call, null);
    if (actionId.startsWith(GRANT)) return this.choose(ctx, call, actionId.slice(GRANT.length));
    return this.list(ctx, call);
  }

  private async list(ctx: ChatContext, call: BillingCallContext): Promise<FlowResult> {
    const read = await this.billing.rewardTarget(call);
    if (!read.ok || !read.data) return { view: say('prizeService.failed', { raw: read.msg }), nextState: null };
    const target = read.data;
    if (target.services.length < 2) return { view: say('prizeService.none', { key: BotKeys.prizeService.none }), nextState: null };

    const marked = (label: BotText, chosen: boolean): BotText => (chosen ? { key: BotKeys.prizeService.chosen, values: { name: label } } : label);
    const rows: BotAction[][] = [
      [{ id: AUTOMATIC, label: marked({ key: BotKeys.prizeService.automatic }, target.chosenGrantId === null) }],
      ...target.services.map((s) => [{ id: `${GRANT}${s.id}`, label: marked(this.optionOf(s, ctx.lang), s.id === target.chosenGrantId) }]),
    ];
    return { view: view('prizeService.screen', { key: BotKeys.prizeService.screen, values: { current: this.current(target, ctx.lang) } }, rows), nextState: null };
  }

  private async choose(ctx: ChatContext, call: BillingCallContext, grantId: string | null): Promise<FlowResult> {
    const done = await this.billing.chooseRewardTarget(grantId, call);
    if (!done.ok || !done.data) {
      const reason = done.error?.reason;
      const body: BotText = reason && reason in REFUSAL_KEYS ? { key: REFUSAL_KEYS[reason] } : { raw: done.msg };
      return { view: say('prizeService.refused', body), nextState: null };
    }
    return { view: say('prizeService.saved', { key: BotKeys.prizeService.saved, values: { current: this.current(done.data, ctx.lang) } }), nextState: null };
  }

  /** The choice billing holds, told as its option is (name, time and GB left); automatic when none. */
  private current(target: ChatRewardTarget, lang: string): BotText {
    const chosen = target.services.find((s) => s.id === target.chosenGrantId);
    return chosen ? this.optionOf(chosen, lang) : { key: BotKeys.prizeService.automatic };
  }

  /** The name, then the time left and the GB left — so two services of one plan are never a guess (F-707-x). */
  private optionOf(s: ChatPrizeService, lang: string): BotText {
    const name = this.nameOf(s, lang);
    const when = timeLeftOf(s.endsAt, new Date());
    if (s.remainingBytes === null) return { key: BotKeys.prizeService.option, values: { name, when } };
    return { key: BotKeys.prizeService.optionWithLeft, values: { name, when, left: { raw: bytesLabel(s.remainingBytes) } } };
  }

  /** As My services names it (`serviceNameOf`); a service only one kind of prize reaches says which. */
  private nameOf(s: ChatPrizeService, lang: string): BotText {
    const name = serviceNameOf(s, lang, this.locale);
    if (!s.takesTraffic) return { key: BotKeys.prizeService.daysOnly, values: { name } };
    if (!s.takesDays) return { key: BotKeys.prizeService.trafficOnly, values: { name } };
    return name;
  }
}
