import { Inject, Injectable, Optional } from '@nestjs/common';
import { BotAction, BotText } from '@txnet-backend/messenger';
import { BillingApiClient, BillingCallContext } from '../billing-api/billing-api.client';
import type { RenewalChoice, RenewalCustom, RenewalInvoice, RenewalPlan } from '../billing-api/renewal.types';
import type { MyService } from '../billing-api/services.types';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { LocaleService } from '../locale/locale.service';
import { money } from '../locale/money';
import { ChatAccess } from '../session/chat-access';
import { parseRenewalAction, renewalAction } from './renewal-actions';
import { bytesLabel, planNameOf, serviceNameOf } from './service-words';
import { findOwnService, serviceAction } from './services.flow';
import { spanUntil } from './span';
import { spellAmount } from './top-up.flow';
import { ACTIONS, ask, say, view } from './views';

/** The clock, injectable so a spec can stand at an invoice's expiry. */
export const RENEWAL_FLOW_CLOCK = Symbol('RENEWAL_FLOW_CLOCK');

/** The steps that wait for typing: GiB, days, or a code for the invoice on screen. */
const STEP = { gib: 'renewal.gib', days: 'renewal.days', invoice: 'renewal.invoice', coupon: 'renewal.coupon' } as const;

/** Billing's refusal of a wallet that holds less than the invoice (billing `contract.purchase.md` "Paying it"). */
const INSUFFICIENT_BALANCE = 'insufficient_balance';
/** A whole number typed, as billing's schema takes it; the bounds are billing's to refuse. */
const WHOLE = /^\d{1,6}$/;
const ZERO = /^0+(\.0+)?$/;

const toServices: BotAction = { id: ACTIONS.services, label: { key: BotKeys.action.servicesBack } };

/**
 * «تمدید» in the chat (F-305-i): the panel's renewal sheet (panel-web
 * `contract.renewal.md`) over billing's own routes, through the gate
 * (ADR-0009). The bot decides nothing: which plans a Grant renews to, what
 * each costs, the bounds of GiB and days typed and every refusal are billing's.
 *
 * Plans, then an invoice, then the wallet (user, 2026-10-22: no in-chat
 * gateway). A short wallet is told how much is missing and led to the
 * top-up; the invoice keeps its 30 minutes, so «دوباره پرداخت» pays the same one.
 *
 * Every button names its Grant or invoice and needs no state. Only the typing
 * does (ADR-0010): the Grant being renewed, and what the invoice on screen was
 * for, so a code typed asks billing again for the same choice — navigation,
 * never a price.
 */
@Injectable()
export class RenewalFlow {
  private readonly now: () => Date;

  constructor(
    private readonly billing: BillingApiClient,
    private readonly access: ChatAccess,
    private readonly locale: LocaleService,
    @Optional() @Inject(RENEWAL_FLOW_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** A renewal button, from any state — the open one also under a renew notice. */
  async tap(ctx: ChatContext, actionId: string, state: NavState | null): Promise<FlowResult> {
    const tapped = parseRenewalAction(actionId);
    if (!tapped) return this.stale();
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();
    switch (tapped.kind) {
      case 'open':
        return this.plans(call, tapped.id);
      case 'plan':
        return this.pickPlan(call, tapped.id, tapped.plan);
      case 'gib':
      case 'days':
        return this.askAmount(call, tapped.id, tapped.kind);
      case 'coupon':
        return this.askCoupon(state, tapped.id);
      case 'pay':
        return this.pay(call, tapped.id);
      case 'cancel':
        return this.cancel(call, tapped.id);
    }
  }

  /** What was typed at a step that asked for it. */
  async handle(ctx: ChatContext, state: NavState, actionId: string | null): Promise<FlowResult> {
    if (actionId !== null) return { view: say('renewal.pickOne', { key: BotKeys.common.pickOne }), nextState: state };
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();
    const { grantId } = state.data;
    if (state.step === STEP.gib || state.step === STEP.days) {
      const typed = spellAmount(ctx.text);
      if (!WHOLE.test(typed)) return { view: say('renewal.notANumber', { key: BotKeys.renewal.notANumber }), nextState: state };
      const n = Number(typed);
      return this.invoice(call, grantId, state.step === STEP.gib ? { gib: n, days: 0 } : { gib: 0, days: n }, [], state);
    }
    const choice = choiceOf(state.data);
    const code = ctx.text?.trim() ?? '';
    if (state.step !== STEP.coupon || !choice) return this.stale();
    if (code === '') return { view: ask('renewal.askCoupon', { key: BotKeys.renewal.askCoupon }), nextState: state };
    // The code is applied when an invoice is made: the one on screen is given up, its holds freed.
    const cancelled = await this.billing.cancelInvoice(state.data.invoiceId, call);
    if (!cancelled.ok) return this.refusal(cancelled.msg);
    return this.invoice(call, grantId, choice, [code], null);
  }

  /** Billing's plans for this Grant, its own first, then the parts it sells typed. */
  private async plans(call: BillingCallContext, grantId: string): Promise<FlowResult> {
    const found = await findOwnService(this.billing, call, grantId);
    if ('view' in found) return found;
    const read = await this.billing.renewalPlans(grantId, call);
    if (!read.ok || !read.data) return this.refusal(read.msg);
    const { plans, custom, ownPlanRenewable } = read.data;
    const buttons: BotAction[][] = [
      ...plans.map((p, i) => [{ id: renewalAction('plan', grantId, i), label: this.planLabel(p, found.service, call.lang) }]),
      ...typedParts(custom).map((part) => [{ id: renewalAction(part, grantId), label: { key: part === 'gib' ? BotKeys.action.renewGib : BotKeys.action.renewDays } }]),
    ];
    const back: BotAction = { id: serviceAction('open', grantId), label: { key: BotKeys.action.back } };
    if (buttons.length === 0) return { view: view('renewal.none', { key: BotKeys.renewal.none }, [[back]]), nextState: null };
    const notSold: BotText = ownPlanRenewable ? { raw: '' } : { key: BotKeys.renewal.notSold };
    const body = { key: BotKeys.renewal.plans, values: { name: serviceNameOf(found.service, call.lang, this.locale), notSold } };
    return { view: view('renewal.plans', body, [...buttons, [back]]), nextState: null };
  }

  /** The plan at that place in billing's list now; one no longer there shows the list again. */
  private async pickPlan(call: BillingCallContext, grantId: string, index: number): Promise<FlowResult> {
    const read = await this.billing.renewalPlans(grantId, call);
    if (!read.ok || !read.data) return this.refusal(read.msg);
    const plan = read.data.plans[index];
    if (!plan) return this.plans(call, grantId);
    return this.invoice(call, grantId, { variantId: plan.variantId }, [], null);
  }

  /** GiB or days typed, within this Grant's bounds as billing answers them. */
  private async askAmount(call: BillingCallContext, grantId: string, part: 'gib' | 'days'): Promise<FlowResult> {
    const found = await findOwnService(this.billing, call, grantId);
    if ('view' in found) return found;
    const read = await this.billing.renewalPlans(grantId, call);
    if (!read.ok || !read.data) return this.refusal(read.msg);
    const custom = read.data.custom;
    if (!custom || !typedParts(custom).includes(part)) return this.plans(call, grantId);
    const [min, max] = part === 'gib' ? [custom.minGib, custom.maxGib] : [custom.minDays, custom.maxDays];
    const key = part === 'gib' ? BotKeys.renewal.askGib : BotKeys.renewal.askDays;
    return {
      view: ask('renewal.askAmount', { key, values: { name: serviceNameOf(found.service, call.lang, this.locale), min, max } }),
      nextState: { flow: 'renewal', step: part === 'gib' ? STEP.gib : STEP.days, data: { grantId } },
    };
  }

  /**
   * Billing prices it and applies the codes. A refusal is its sentence; at a
   * typing step (`retry`) the same question stays open, so a number out of
   * bounds can be typed again.
   */
  private async invoice(call: BillingCallContext, grantId: string, choice: RenewalChoice, codes: string[], retry: NavState | null): Promise<FlowResult> {
    const made = await this.billing.createRenewalInvoice(grantId, choice, codes, call);
    if (!made.ok || !made.data) return { ...this.refusal(made.msg), nextState: retry };
    const inv = made.data;
    const values = {
      plan: planNameOf(inv, call.lang, this.locale),
      adds: addsOf(inv.renewal?.bytes ?? '0', inv.renewal?.days ?? 0, false),
      amount: money(inv.amount, inv.currencyCode),
      discount: ZERO.test(inv.discount) ? { raw: '' } : { key: BotKeys.renewal.discount, values: { discount: money(inv.discount, inv.currencyCode) } },
      total: money(inv.total, inv.currencyCode),
      left: spanUntil(new Date(inv.expiresAt).getTime(), this.now().getTime(), BotKeys.services.left),
      rejected: rejectedOf(inv),
    };
    return {
      view: view('renewal.invoice', { key: BotKeys.renewal.invoice, values }, [
        [{ id: renewalAction('pay', inv.id), label: { key: BotKeys.action.renewPay } }],
        [{ id: renewalAction('coupon', inv.id), label: { key: BotKeys.action.renewCoupon } }],
        [{ id: renewalAction('cancel', inv.id), label: { key: BotKeys.action.cancel } }],
      ]),
      nextState: { flow: 'renewal', step: STEP.invoice, data: { grantId, invoiceId: inv.id, ...choiceData(choice) } },
    };
  }

  /** A code is typed only for the invoice on screen: an old screen's button sends nothing. */
  private askCoupon(state: NavState | null, invoiceId: string): FlowResult {
    if (state?.step !== STEP.invoice || state.data.invoiceId !== invoiceId) return this.stale();
    return { view: ask('renewal.askCoupon', { key: BotKeys.renewal.askCoupon }), nextState: { ...state, step: STEP.coupon } };
  }

  /** From the wallet. Nothing is patched from the answer: the service's screen is read again from its button. */
  private async pay(call: BillingCallContext, invoiceId: string): Promise<FlowResult> {
    const paid = await this.billing.payInvoice(invoiceId, call);
    if (paid.ok && paid.data) {
      const p = paid.data;
      const toService: BotAction[][] = p.grants[0] ? [[{ id: serviceAction('open', p.grants[0].id), label: { key: BotKeys.action.servicesBack } }]] : [[toServices]];
      const body = { key: BotKeys.renewal.paid, values: { total: money(p.total, p.currencyCode), balance: money(p.balanceAfter, p.currencyCode) } };
      return { view: view('renewal.paid', body, toService), nextState: null };
    }
    const facts = paid.error?.facts;
    if (paid.error?.reason !== INSUFFICIENT_BALANCE || !facts?.missing) return this.refusal(paid.msg);
    return {
      view: view('renewal.shortfall', { key: BotKeys.renewal.shortfall, values: { missing: money(facts.missing, facts.currencyCode) } }, [
        [{ id: ACTIONS.topUp, label: { key: BotKeys.action.topUp } }],
        [{ id: renewalAction('pay', invoiceId), label: { key: BotKeys.action.renewPayAgain } }],
      ]),
      nextState: null,
    };
  }

  private async cancel(call: BillingCallContext, invoiceId: string): Promise<FlowResult> {
    const done = await this.billing.cancelInvoice(invoiceId, call);
    if (!done.ok) return this.refusal(done.msg);
    return { view: view('renewal.cancelled', { key: BotKeys.renewal.cancelled }, [[toServices]]), nextState: null };
  }

  /** A plan's button: its name, what it adds to this service and its price before any code. */
  private planLabel(p: RenewalPlan, s: MyService, lang: string): BotText {
    const values = { name: planNameOf(p, lang, this.locale), adds: addsOf(p.bytes, p.days, s.trafficUnlimited), price: money(p.price, p.currencyCode) };
    return { key: p.current ? BotKeys.renewal.planCurrent : BotKeys.renewal.plan, values };
  }

  private refusal(msg: string): FlowResult {
    return { view: view('renewal.refused', { raw: msg }, [[toServices]]), nextState: null };
  }

  private stale(): FlowResult {
    return { view: say('renewal.stale', { key: BotKeys.renewal.stale }), nextState: null };
  }

  private async callContext(ctx: ChatContext): Promise<BillingCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken, platform: ctx.platform, botTenantId: ctx.integration.tenantId } : null;
  }

  private signedOut(): FlowResult {
    return { view: say('renewal.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}

/** The parts this Grant may buy typed: a most of 0 is a part it cannot take (billing rule 6). */
function typedParts(custom: RenewalCustom | null): Array<'gib' | 'days'> {
  if (!custom) return [];
  return [...(custom.maxGib > 0 ? (['gib'] as const) : []), ...(custom.maxDays > 0 ? (['days'] as const) : [])];
}

/** What it adds: traffic and days, either alone; unlimited traffic said as such, never 0 GB. */
function addsOf(bytes: string, days: number, unlimited: boolean): BotText {
  const traffic: BotText | null = bytes !== '0' ? { raw: bytesLabel(bytes) } : unlimited ? { key: BotKeys.renewal.unlimited } : null;
  const time: BotText | null = days > 0 ? { key: BotKeys.renewal.addsDays, values: { d: days } } : null;
  if (traffic && time) return { key: BotKeys.renewal.addsBoth, values: { traffic, days: time } };
  return traffic ?? time ?? { raw: '' };
}

/** A code billing would not take, in its words; one code is typed at a time in the chat. */
function rejectedOf(inv: RenewalInvoice): BotText {
  const first = inv.rejected?.[0];
  return first ? { key: BotKeys.renewal.rejected, values: { code: first.code, message: first.message } } : { raw: '' };
}

/** What the invoice on screen was for, as the typing step keeps it (strings: navigation state). */
function choiceData(choice: RenewalChoice): Record<string, string> {
  return 'variantId' in choice ? { variantId: choice.variantId } : { gib: String(choice.gib), days: String(choice.days) };
}

function choiceOf(data: Record<string, string>): RenewalChoice | null {
  if (data.variantId) return { variantId: data.variantId };
  return data.gib !== undefined && data.days !== undefined ? { gib: Number(data.gib), days: Number(data.days) } : null;
}
