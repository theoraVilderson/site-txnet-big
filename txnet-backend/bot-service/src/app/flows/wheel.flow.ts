import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { BotText } from '@txnet-backend/messenger';
import { BillingApiClient, BillingCallContext } from '../billing-api/billing-api.client';
import type { SpinAnswer, WheelPrizeType } from '../billing-api/engagement.types';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotKey, BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import { prizeServiceRows } from './prize-service.flow';
import { ACTIONS, say, view } from './views';

/** Every reason billing gives for no spin — recorded (`SpinRefusalReason`) or not (`WheelSpinRejection`). */
const REFUSAL_KEYS: Record<string, BotKey> = BotKeys.wheel.refusals;
const WON_KEYS: Record<WheelPrizeType, BotKey> = BotKeys.wheel.won;

const spinButton = [[{ id: ACTIONS.wheelSpin, label: { key: BotKeys.action.wheelSpin } }]];

/** `"1.50"` -> `"1.5"`, `"30.00"` -> `"30"`: a figure as people say it. */
const plain = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

/** A reason's own sentence; an unknown one (a newer billing) falls back to billing's translated `msg`. */
function reasonText(reason: string | null | undefined, msg?: string): BotText {
  if (reason && reason in REFUSAL_KEYS) return { key: REFUSAL_KEYS[reason] };
  return msg ? { raw: msg } : { key: BotKeys.common.tryAgain };
}

/**
 * The lucky wheel in the chat (F-707-h, ADR-0111 point 4): the panel's own
 * `/api/billing/wheel` routes, through the gate, so the chat has the same
 * odds, limits and history as the panel (ADR-0009). The device a spin names
 * is this chat — the gate writes it from the session, never this bot.
 *
 * The bot decides nothing and keeps one thing: the screen's `requestId`, so
 * a Spin tapped again after a lost answer is the same spin. Any answer ends
 * the conversation; the next screen is a new key.
 */
@Injectable()
export class WheelFlow {
  constructor(
    private readonly billing: BillingApiClient,
    private readonly access: ChatAccess,
  ) {}

  /** The odds, and either a Spin button or why not; the prize-service row under them when there is a choice (F-707-t). */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();

    const [read, prizeRows] = await Promise.all([this.billing.wheel(call), prizeServiceRows(this.billing, call)]);
    if (!read.ok || !read.data) {
      if (read.error?.reason === 'no_wheel') return { view: say('wheel.none', { key: BotKeys.wheel.none }), nextState: null };
      return { view: say('wheel.failed', { raw: read.msg }), nextState: null };
    }

    const w = read.data;
    // A slot's name is the tenant's data, not copy: shown as it is.
    const odds: BotText = { raw: w.prizes.map((p) => `${p.label} — ${plain(p.oddsPercent)}%`).join('\n') };
    const status: BotText = w.eligible
      ? { key: BotKeys.wheel.canSpin, values: { n: w.spinsLeftToday } }
      : { key: BotKeys.wheel.cannotSpin, values: { reason: reasonText(w.refusalReason) } };
    const body: BotText = { key: BotKeys.wheel.screen, values: { odds, status } };
    if (!w.eligible) return { view: prizeRows.length ? view('wheel.screen', body, prizeRows) : say('wheel.screen', body), nextState: null };
    return {
      view: view('wheel.screen', body, [...spinButton, ...prizeRows]),
      nextState: { flow: 'wheel', step: 'wheel.offer', data: { requestId: randomUUID() } },
    };
  }

  async handle(ctx: ChatContext, state: NavState, actionId: string | null): Promise<FlowResult> {
    if (actionId !== ACTIONS.wheelSpin || !state.data.requestId) return this.start(ctx);

    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();

    const spun = await this.billing.spinWheel(state.data.requestId, call);
    if (!spun.ok || !spun.data) {
      const reason = spun.error?.reason;
      // No reason: the answer was lost and the spin may have happened. Keep the
      // key, so the next tap is answered with that spin rather than a new one.
      // `spin_in_progress` is this very tap still running: the same holds.
      if (!reason || reason === 'spin_in_progress') {
        return { view: view('wheel.failed', { key: BotKeys.wheel.failed }, spinButton), nextState: state };
      }
      return { view: say('wheel.refused', { key: BotKeys.wheel.refused, values: { reason: reasonText(reason, spun.msg) } }), nextState: null };
    }
    return { view: say('wheel.result', told(spun.data)), nextState: null };
  }

  private async callContext(ctx: ChatContext): Promise<BillingCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken, platform: ctx.platform, botTenantId: ctx.integration.tenantId } : null;
  }

  private signedOut(): FlowResult {
    return { view: say('wheel.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}

/** What the chat says: the prize by its kind (a coupon with its code), a refusal by its reason, else nothing won. */
function told(a: SpinAnswer): BotText {
  if (a.status !== 'awarded') return { key: BotKeys.wheel.refused, values: { reason: reasonText(a.refusalReason) } };
  if (!a.prize || a.prize.prizeType === 'empty') return { key: BotKeys.wheel.won.empty };
  return {
    key: WON_KEYS[a.prize.prizeType],
    values: { value: plain(a.prize.prizeValue), label: a.prize.label, code: a.reward?.coupon?.code ?? '' },
  };
}
