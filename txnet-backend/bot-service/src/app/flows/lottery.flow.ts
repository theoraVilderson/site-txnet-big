import { Inject, Injectable, Optional } from '@nestjs/common';
import { BotAction, BotText } from '@txnet-backend/messenger';
import { BillingApiClient, BillingCallContext, ChatLottery, ChatLotteryResult } from '../billing-api/billing-api.client';
import { ChatContext, FlowResult } from '../conversation/nav.types';
import { BotKey, BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import { ACTIONS, say, view } from './views';

/** Billing's `ExclusionReason` (the close, F-707-k); the spec reads the union from the service. */
export const LOTTERY_EXCLUDED_KEYS: Record<string, BotKey> = BotKeys.lotteries.excluded;
/** Billing's `LotteryEntryRejection` (the entry and result routes). */
export const LOTTERY_REFUSAL_KEYS: Record<string, BotKey> = BotKeys.lotteries.refusals;

/** A lottery's own buttons carry its id, so they need no conversation state: `lot:<o|j|l|r>:<id>`, 42 bytes. */
export const LOTTERY_ACTION_PREFIX = 'lot:';
const KIND = { open: 'o', join: 'j', leave: 'l', result: 'r' } as const;
type Kind = keyof typeof KIND;
const KIND_OF: Record<string, Kind> = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k as Kind]));

export const lotteryAction = (kind: Kind, id: string) => `${LOTTERY_ACTION_PREFIX}${KIND[kind]}:${id}`;

/** The clock, injectable so a spec can stand at a close time. */
export const LOTTERY_FLOW_CLOCK = Symbol('LOTTERY_FLOW_CLOCK');

/** Buttons on the list; billing answers at most 30, newest close first. */
const LIST_MAX = 10;

const back: BotAction = { id: ACTIONS.lotteries, label: { key: BotKeys.action.lotteriesBack } };
const raw = (v: string | null | undefined): BotText => ({ raw: v ?? '' });

/**
 * Lotteries in the chat (F-707-p, ADR-0111 points 5, 6): the panel's own
 * `/api/billing/lotteries` routes, through the gate, so the chat shows the
 * same lotteries, entry and tickets as the panel (ADR-0009).
 *
 * The bot decides nothing: billing says which lotteries this user sees, which
 * may be joined, and who got a ticket. The screen offers Join only where the
 * panel does (an open `opt_in` lottery with no entry), Leave only to one who
 * joined, and the result once drawn. Every button names its lottery, so a tap
 * on an old screen still means what it says; each answer ends the conversation.
 *
 * The winner is told by F-707-m's `lotteryWon` notice (inbox and one
 * messenger); the check of the draw is the panel's (F-707-n).
 */
@Injectable()
export class LotteryFlow {
  private readonly now: () => Date;

  constructor(
    private readonly billing: BillingApiClient,
    private readonly access: ChatAccess,
    @Optional() @Inject(LOTTERY_FLOW_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** The list: one button per lottery, its title as the tenant wrote it and its status. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();
    const read = await this.billing.lotteries(call);
    if (!read.ok || !read.data) return { view: say('lotteries.failed', { raw: read.msg }), nextState: null };
    const rows = read.data.slice(0, LIST_MAX);
    if (rows.length === 0) return { view: say('lotteries.none', { key: BotKeys.lotteries.none }), nextState: null };
    return {
      view: view(
        'lotteries.list',
        { key: BotKeys.lotteries.list, values: { n: rows.length } },
        rows.map((l) => [{ id: lotteryAction('open', l.id), label: { key: BotKeys.lotteries.item, values: { title: raw(l.title), status: this.status(l, false) } } }]),
      ),
      nextState: null,
    };
  }

  /** A lottery's own button. Unknown kinds open the list. */
  async tap(ctx: ChatContext, actionId: string): Promise<FlowResult> {
    const [kindCode, id] = actionId.slice(LOTTERY_ACTION_PREFIX.length).split(':');
    const kind = KIND_OF[kindCode];
    if (!kind || !id) return this.start(ctx);
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();

    if (kind === 'join' || kind === 'leave') {
      const done = await (kind === 'join' ? this.billing.joinLottery(id, call) : this.billing.leaveLottery(id, call));
      if (!done.ok) return { view: say('lotteries.refused', reasonText(done.error?.reason, done.msg)), nextState: null };
      return this.card(call, id);
    }
    if (kind === 'result') return this.result(call, id);
    return this.card(call, id);
  }

  /** One lottery as billing now sees it for this user; the list has no single-lottery route, so it is read and searched. */
  private async card(call: BillingCallContext, id: string): Promise<FlowResult> {
    const read = await this.billing.lotteries(call);
    if (!read.ok || !read.data) return { view: say('lotteries.failed', { raw: read.msg }), nextState: null };
    const l = read.data.find((x) => x.id === id);
    if (!l) return { view: say('lotteries.gone', { key: BotKeys.lotteries.refusals.lottery_not_found }), nextState: null };

    const entry = this.entry(l);
    const buttons: BotAction[][] = [];
    if (entry.offer) buttons.push([{ id: lotteryAction(entry.offer, l.id), label: { key: entry.offer === 'join' ? BotKeys.action.lotteryJoin : BotKeys.action.lotteryLeave } }]);
    if (l.status === 'drawn') buttons.push([{ id: lotteryAction('result', l.id), label: { key: BotKeys.action.lotteryResult } }]);
    buttons.push([back]);
    return {
      view: view(
        'lotteries.card',
        {
          key: BotKeys.lotteries.card,
          values: {
            title: raw(l.title),
            description: raw(l.description),
            status: this.status(l, true),
            closes: l.status === 'published' && l.open ? { key: BotKeys.lotteries.closesIn, values: { left: this.left(l.closesAt) } } : raw(''),
            // A prize's name is the tenant's data, shown as it is; `×n` is how many win it.
            prizes: raw(l.prizes.map((p) => `${p.rank}. ${p.label} ×${p.winnersCount}`).join('\n')),
            entry: entry.text,
          },
        },
        buttons,
      ),
      nextState: null,
    };
  }

  private async result(call: BillingCallContext, id: string): Promise<FlowResult> {
    const read = await this.billing.lotteryResult(id, call);
    if (!read.ok || !read.data) return { view: say('lotteries.refused', reasonText(read.error?.reason, read.msg)), nextState: null };
    return { view: view('lotteries.result', told(read.data), [[back]]), nextState: null };
  }

  /** The pill; `cancelled` carries the admin's public reason. An open one past its close reads "closing" until the freeze. */
  private status(l: ChatLottery, withReason: boolean): BotText {
    if (l.status === 'published') return { key: l.open ? BotKeys.lotteries.status.open : BotKeys.lotteries.status.closing };
    if (l.status === 'cancelled') return { key: BotKeys.lotteries.status.cancelled, values: { reason: raw(withReason ? l.cancelReason : '') } };
    return { key: BotKeys.lotteries.status[l.status] };
  }

  /** What the card says about this user's entry, and the one entry button it offers (F-707-j rules 1–4). */
  private entry(l: ChatLottery): { text: BotText; offer: 'join' | 'leave' | null } {
    if (l.entry?.ticketNumber != null) return { text: { key: BotKeys.lotteries.entry.ticket, values: { n: l.entry.ticketNumber } }, offer: null };
    if (l.entry?.excludedReason) return { text: { key: BotKeys.lotteries.entry.excluded, values: { reason: reasonText(l.entry.excludedReason, undefined, LOTTERY_EXCLUDED_KEYS) } }, offer: null };
    if (l.open && l.status === 'published') {
      if (l.entryMode === 'automatic') return { text: { key: BotKeys.lotteries.entry.automatic }, offer: null };
      return l.entry ? { text: { key: BotKeys.lotteries.entry.joined }, offer: 'leave' } : { text: { key: BotKeys.lotteries.entry.canJoin }, offer: 'join' };
    }
    return { text: raw(''), offer: null };
  }

  /** Time to the close, as a span: a span needs no time zone. */
  private left(closesAt: string): BotText {
    const minutes = Math.max(0, Math.floor((new Date(closesAt).getTime() - this.now().getTime()) / 60_000));
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    if (d > 0) return { key: BotKeys.lotteries.left.days, values: { d, h } };
    if (h > 0) return { key: BotKeys.lotteries.left.hours, values: { h, m } };
    return { key: BotKeys.lotteries.left.minutes, values: { m } };
  }

  private async callContext(ctx: ChatContext): Promise<BillingCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken, platform: ctx.platform, botTenantId: ctx.integration.tenantId } : null;
  }

  private signedOut(): FlowResult {
    return { view: say('lotteries.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}

/** A reason's own sentence; an unknown one (a newer billing) falls back to billing's translated `msg`. */
function reasonText(reason: string | null | undefined, msg?: string, table: Record<string, BotKey> = LOTTERY_REFUSAL_KEYS): BotText {
  if (reason && reason in table) return { key: table[reason] };
  return msg ? { raw: msg } : { key: BotKeys.common.tryAgain };
}

const DELIVERY_MARK: Record<ChatLotteryResult['places'][number]['delivery'], string> = { pending: '⏳', delivered: '✅', passed_on: '↪️' };

/** The prize places with their delivery, and whether this user's ticket won. Reserves that took nothing are left out. */
function told(r: ChatLotteryResult): BotText {
  const prized = r.places.filter((p) => p.prize);
  const places: BotText = prized.length
    ? raw(prized.map((p) => `${p.position}. #${p.ticketNumber} — ${p.prize?.label} ${DELIVERY_MARK[p.delivery]}${p.replacesPosition !== null ? ` (${p.replacesPosition})` : ''}`).join('\n'))
    : { key: BotKeys.lotteries.noPlaces };
  const myTicket = r.mine?.ticketNumber ?? null;
  const mineWon = myTicket !== null ? prized.find((p) => p.ticketNumber === myTicket && p.delivery !== 'passed_on') : undefined;
  const mine: BotText =
    myTicket === null
      ? raw('')
      : mineWon
        ? { key: BotKeys.lotteries.mine.won, values: { prize: raw(mineWon.prize?.label) } }
        : { key: BotKeys.lotteries.mine.lost, values: { n: myTicket } };
  return { key: BotKeys.lotteries.result, values: { title: raw(r.title), n: r.entrantCount, places, mine } };
}
