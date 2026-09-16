import { Injectable } from '@nestjs/common';
import { BotAction } from '@txnet-backend/messenger';
import { BillingApiClient, BillingCallContext, DepositBody } from '../billing-api/billing-api.client';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import { digitValue } from './phone-number';
import { ACTIONS, ask, say, toMenu, view } from './views';

/** `topup:g:<source>:<gatewayId>` — which gateway, as the list answered it. */
export const GATEWAY_ACTION_PREFIX = 'topup:g:';
/** `topup:a:<amount>` — one of the gateway's quick amounts (F-092-v). */
export const AMOUNT_ACTION_PREFIX = 'topup:a:';

/**
 * Topping up the wallet inside the chat (F-306-a): gateway, amount, the quote,
 * then `start` — the panel's own deposit routes, through the gate (ADR-0009).
 *
 * **Every number on these screens is billing's.** The amount the user typed is
 * spelled into ASCII digits and handed over untouched; whether it is in range,
 * what the fee is and what reaches the wallet are the quote's answers, and a
 * refusal arrives as billing's own translated sentence.
 *
 * Only navigation is kept (ADR-0010): the gateway picked and the amount typed.
 * No price is ever stored — `start` takes the quote's body and re-prices it. The
 * moment `start` answers, the payment is a row billing owns, so the
 * conversation ends there: a stale Pay button can never start a second one.
 *
 * The result of paying at the bank comes back as a message: billing announces
 * the credit and `worker-service`'s payer notice tells every linked chat, for a
 * payment started here even when a webhook settled it
 * (`automation/contract.outbox.md`).
 */
@Injectable()
export class TopUpFlow {
  constructor(
    private readonly billing: BillingApiClient,
    private readonly access: ChatAccess,
  ) {}

  /** The gateway list. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();

    const listed = await this.billing.listGateways(call);
    if (!listed.ok || !listed.data) return { view: say('topUp.failed', { raw: listed.msg }), nextState: null };
    if (!listed.data.length) return { view: say('topUp.none', { key: BotKeys.topUp.none }), nextState: null };

    return {
      view: ask(
        'topUp.gateway',
        { key: BotKeys.topUp.pickGateway },
        // A gateway's name is the tenant's data, not copy — shown as it is.
        listed.data.map((g) => [{ id: `${GATEWAY_ACTION_PREFIX}${g.source}:${g.id}`, label: { raw: g.displayName } }]),
      ),
      nextState: { flow: 'topUp', step: 'topUp.gateway', data: {} },
    };
  }

  async handle(ctx: ChatContext, state: NavState, actionId: string | null): Promise<FlowResult> {
    if (state.step === 'topUp.gateway' && actionId?.startsWith(GATEWAY_ACTION_PREFIX)) {
      return this.pickGateway(ctx, state, actionId.slice(GATEWAY_ACTION_PREFIX.length));
    }
    if (state.step === 'topUp.amount') {
      const amount = actionId?.startsWith(AMOUNT_ACTION_PREFIX)
        ? actionId.slice(AMOUNT_ACTION_PREFIX.length)
        : actionId === null
          ? spellAmount(ctx.text)
          : '';
      if (amount) return this.quote(ctx, state, amount);
    }
    if (state.step === 'topUp.confirm' && actionId === ACTIONS.topUpPay) return this.pay(ctx, state);

    return { view: say('topUp.pickOne', { key: BotKeys.common.pickOne }), nextState: state };
  }

  /**
   * The gateway, re-read from the list rather than taken off the button: the
   * screen may be minutes old, and a payload is input, not a fact.
   */
  private async pickGateway(ctx: ChatContext, state: NavState, picked: string): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();

    const listed = await this.billing.listGateways(call);
    if (!listed.ok || !listed.data) return { view: say('topUp.failed', { raw: listed.msg }), nextState: state };
    const gateway = listed.data.find((g) => `${g.source}:${g.id}` === picked);
    if (!gateway) return { view: say('topUp.gone', { key: BotKeys.common.tryAgain }), nextState: state };

    const presets: BotAction[][] = gateway.presets.map((amount) => [
      { id: `${AMOUNT_ACTION_PREFIX}${amount}`, label: { raw: amount } },
    ]);
    return {
      view: ask('topUp.amount', { key: BotKeys.topUp.askAmount }, presets),
      nextState: {
        flow: 'topUp',
        step: 'topUp.amount',
        data: { gatewayId: gateway.id, source: gateway.source, gateway: gateway.displayName },
      },
    };
  }

  /** Billing's price for that amount, and the one button that pays it. */
  private async quote(ctx: ChatContext, state: NavState, amount: string): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();

    const quoted = await this.billing.quote(bodyOf(state, amount), call);
    if (!quoted.ok || !quoted.data) return { view: say('topUp.refused', { raw: quoted.msg }), nextState: state };

    const q = quoted.data;
    return {
      view: ask(
        'topUp.confirm',
        { key: BotKeys.topUp.quote, values: { amount: q.amount, fee: q.fee, payable: q.payable, credited: q.credited } },
        [[{ id: ACTIONS.topUpPay, label: { key: BotKeys.action.toPayment } }]],
      ),
      nextState: { flow: 'topUp', step: 'topUp.confirm', data: { ...state.data, amount } },
    };
  }

  /** `start`, with exactly the body that was quoted. */
  private async pay(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();

    const started = await this.billing.start(bodyOf(state, state.data.amount), call);
    if (!started.ok || !started.data) return { view: say('topUp.refused', { raw: started.msg }), nextState: null };

    const s = started.data;
    if (s.free || !s.redirectUrl) {
      return {
        view: say('topUp.credited', { key: BotKeys.topUp.credited, values: { credited: s.credited, balance: s.balance ?? '' } }),
        nextState: null,
      };
    }
    return {
      view: view('topUp.pay', { key: BotKeys.topUp.pay }, [
        [{ id: 'topup:open', kind: 'url', url: s.redirectUrl, label: { key: BotKeys.action.payNow } }],
        [toMenu],
      ]),
      nextState: null,
    };
  }

  private async callContext(ctx: ChatContext): Promise<BillingCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken } : null;
  }

  private signedOut(): FlowResult {
    return { view: say('topUp.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}

function bodyOf(state: NavState, amount: string): DepositBody {
  return {
    gatewayId: state.data.gatewayId,
    source: state.data.source === 'platform' ? 'platform' : 'tenant',
    amount,
  };
}

/**
 * A typed amount in the form billing reads: digits in any script as ASCII, the
 * Persian decimal separator as `.`, grouping and spaces dropped. It spells and
 * never judges — anything left over travels on and returns as billing's
 * refusal. Empty means nothing was typed.
 */
export function spellAmount(text: string | undefined): string {
  return (text ?? '')
    .trim()
    .replace(/\p{Nd}/gu, (d) => digitValue(d))
    .replace(/[٫]/g, '.')
    .replace(/[\s,،٬]/g, '');
}
