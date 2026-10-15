import { Inject, Injectable, Optional } from '@nestjs/common';
import { BotAction, BotText } from '@txnet-backend/messenger';
import { remainingLabel } from '@txnet-backend/shared-core';
import { BillingApiClient, BillingCallContext } from '../billing-api/billing-api.client';
import type { GrantStatus, MyService } from '../billing-api/services.types';
import { ChatContext, FlowResult } from '../conversation/nav.types';
import { BotKey, BotKeys } from '../locale/bot-keys';
import { LocaleService } from '../locale/locale.service';
import { ChatAccess } from '../session/chat-access';
import { ACTIONS, say, view } from './views';

/** Every entitlement status in the chat's words; the spec holds it to the Prisma enum. */
export const SERVICE_STATUS_KEYS: Record<GrantStatus, BotKey> = BotKeys.services.status;

/** A service's own buttons carry its id, so they need no conversation state: `svc:<kind>:<id>`, 42 bytes. */
export const SERVICE_ACTION_PREFIX = 'svc:';
const KIND = { open: 'o' } as const;
type Kind = keyof typeof KIND;
const KIND_OF: Record<string, Kind> = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k as Kind]));

export const serviceAction = (kind: Kind, id: string) => `${SERVICE_ACTION_PREFIX}${KIND[kind]}:${id}`;

/** The clock, injectable so a spec can stand at a service's end. */
export const SERVICES_FLOW_CLOCK = Symbol('SERVICES_FLOW_CLOCK');

/** Buttons on the list: a chat is no place for a long one, and the app shows them all. */
const LIST_MAX = 10;
/** The card finds its row in billing's largest page (`pageSize ≤ 100`): there is no single-Grant route. */
const CARD_READ_MAX = 100;
const DAY_MS = 86_400_000;
/** A catalog name key is `catalog.<entry>`, served from the `catalog` namespace (as auth-service's notices read it). */
const CATALOG_PREFIX = 'catalog.';

const back: BotAction = { id: ACTIONS.services, label: { key: BotKeys.action.servicesBack } };

/**
 * My services in the chat (F-307-y): the panel's own `GET /api/billing/gift/grants`,
 * through the gate, so the chat names the same services in the same state as
 * My services (ADR-0009). The bot decides nothing; billing's list does.
 *
 * List, then a service's screen: what it is called, its status, its traffic
 * and its time. Every button names its service, so a tap on an old screen
 * still means what it says; each answer ends the conversation. What may be
 * done to a service from here is added by the rows that ride this screen.
 */
@Injectable()
export class ServicesFlow {
  private readonly now: () => Date;

  constructor(
    private readonly billing: BillingApiClient,
    private readonly access: ChatAccess,
    private readonly locale: LocaleService,
    @Optional() @Inject(SERVICES_FLOW_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** The list: one button per service, named and with its status; how many more the app holds. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();
    const read = await this.billing.myServices(LIST_MAX, call);
    if (!read.ok || !read.data) return { view: say('services.failed', { raw: read.msg }), nextState: null };
    const { rows, total } = read.data;
    if (rows.length === 0) return { view: say('services.none', { key: BotKeys.services.none }), nextState: null };
    const more: BotText = total > rows.length ? { key: BotKeys.services.more, values: { n: total - rows.length } } : { raw: '' };
    return {
      view: view(
        'services.list',
        { key: BotKeys.services.list, values: { n: total, more } },
        rows.map((s) => [{ id: serviceAction('open', s.id), label: { key: BotKeys.services.item, values: { name: this.name(s, ctx.lang), status: statusOf(s) } } }]),
      ),
      nextState: null,
    };
  }

  /** A service's own button. An unknown kind opens the list. */
  async tap(ctx: ChatContext, actionId: string): Promise<FlowResult> {
    const [kindCode, id] = actionId.slice(SERVICE_ACTION_PREFIX.length).split(':');
    if (!KIND_OF[kindCode] || !id) return this.start(ctx);
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();
    return this.card(call, id);
  }

  /** One service as billing now lists it. */
  private async card(call: BillingCallContext, id: string): Promise<FlowResult> {
    const read = await this.billing.myServices(CARD_READ_MAX, call);
    if (!read.ok || !read.data) return { view: say('services.failed', { raw: read.msg }), nextState: null };
    const s = read.data.rows.find((x) => x.id === id);
    if (!s) return { view: view('services.gone', { key: BotKeys.services.gone }, [[back]]), nextState: null };
    const values = { name: this.name(s, call.lang), status: statusOf(s), traffic: trafficOf(s), time: this.timeOf(s) };
    return { view: view('services.card', { key: BotKeys.services.card, values }, [[back]]), nextState: null };
  }

  /**
   * As My services and every notice name it (F-307-x): the buyer's own name,
   * else the catalog's in the chat's language (else the default one), else the
   * sku. A name key with no text is never shown as itself.
   */
  private name(s: MyService, lang: string): BotText {
    if (s.label) return { raw: s.label };
    const catalog = this.catalogName(s.variant?.nameKey ?? null, lang);
    if (catalog) return { raw: catalog };
    return s.variant?.sku ? { raw: s.variant.sku } : { key: BotKeys.services.unnamed };
  }

  private catalogName(key: string | null, lang: string): string | undefined {
    if (!key?.startsWith(CATALOG_PREFIX)) return undefined;
    const entry = key.slice(CATALOG_PREFIX.length);
    const text = this.locale.getKey(lang, 'catalog', entry) ?? this.locale.getKey(this.locale.getDefaultLanguage(), 'catalog', entry);
    return typeof text === 'string' && text !== '' ? text : undefined;
  }

  /** Time to the end as whole days — a span needs no time zone, as the lotteries' does. */
  private timeOf(s: MyService): BotText {
    if (!s.endsAt) return { key: BotKeys.services.time.permanent };
    const leftMs = new Date(s.endsAt).getTime() - this.now().getTime();
    if (leftMs <= 0) return { key: BotKeys.services.time.ended };
    if (leftMs < DAY_MS) return { key: BotKeys.services.time.today };
    return { key: BotKeys.services.time.left, values: { d: Math.floor(leftMs / DAY_MS) } };
  }

  private async callContext(ctx: ChatContext): Promise<BillingCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken, platform: ctx.platform, botTenantId: ctx.integration.tenantId } : null;
  }

  private signedOut(): FlowResult {
    return { view: say('services.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}

/** A frozen Grant is `suspended` underneath; the user knows it as frozen. */
function statusOf(s: MyService): BotText {
  return { key: s.frozen ? BotKeys.services.frozen : SERVICE_STATUS_KEYS[s.status] };
}

/** The traffic line by the Grant's kind: unlimited, pay as you go, against a cap, or used alone. */
function trafficOf(s: MyService): BotText {
  const used = bytesLabel(s.consumedBytes);
  if (s.trafficUnlimited) return { key: BotKeys.services.traffic.unlimited, values: { used } };
  if (s.billingMode === 'metered') return { key: BotKeys.services.traffic.metered, values: { used } };
  if (s.trafficCapBytes !== null) return { key: BotKeys.services.traffic.capped, values: { used, cap: bytesLabel(s.trafficCapBytes) } };
  return { key: BotKeys.services.traffic.used, values: { used } };
}

/** Bytes as the notices say them (`remainingLabel`); nothing used reads 0, not its "at least 1 MB". */
function bytesLabel(bytes: string): string {
  const n = BigInt(bytes);
  return n === BigInt(0) ? '0 MB' : remainingLabel(n);
}
