import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ResellerUser, ResellerUserStatus } from '../auth-api/auth-api.types';
import { BillingApiClient } from '../billing-api/billing-api.client';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { ResellerCampaignFlow } from './reseller-campaign.flow';
import { ChatAccess } from '../session/chat-access';
import { TenantApiClient } from '../tenant-api/tenant-api.client';
import {
  ACTIONS,
  RESELLER_BLOCK_PREFIX,
  RESELLER_PAGE_PREFIX,
  RESELLER_UNBLOCK_PREFIX,
  RESELLER_USER_PREFIX,
  resellerBlockConfirmView,
  resellerMenu,
  resellerRevenueView,
  resellerUserView,
  resellerUsersView,
  say,
} from './views';

/** How many customers one screen holds. A chat keyboard past this stops being readable. */
export const USERS_PER_PAGE = 8;

/** `q` is three characters or nothing (`contract.reseller-users.md`) — a single letter is a dump. */
export const MIN_SEARCH_LENGTH = 3;

/**
 * The status a user is in, as a sentence (C-07): an exhaustive `Record` over
 * the union, so a fourth state is a compile error rather than a raw key in a
 * chat.
 */
const STATUS_KEY: Record<ResellerUserStatus, string> = {
  active: BotKeys.reseller.statusActive,
  suspended: BotKeys.reseller.statusSuspended,
  banned: BotKeys.reseller.statusBanned,
};

/**
 * The reseller management panel inside the bot (`F-311-c`, spec F-311): the
 * customer list with search, block and unblock, and what the reseller earned.
 *
 * **Every fact on these screens belongs to another unit** (`bot-app/contract.md`,
 * "the decision belongs to"): the users and the two writes are `auth-api`'s
 * (F-311-a), the two figures are billing's (F-311-b), and whether this chat may
 * see any of it at all is the door's (`GET /api/tenants/:id/access`, F-311-e).
 * This file owns the order of the screens and nothing else.
 *
 * **The reseller is the bot's, never the session's.** `ctx.integration.tenantId`
 * is the tenant whose webhook path this update arrived on (F-320), and every
 * call below names it in the path. It cannot come from the session: the owner
 * signs in in their own platform tenant (ADR-0059 (6), F-061-i), which is the
 * exact gap F-311-e was split off to close.
 *
 * **No verdict is remembered.** It is re-read for the menu row and again for
 * any screen that offers a write, for ADR-0033's reason: a seat revoked a
 * second ago must stop administering, and a cached "yes" is a button that
 * fails on its first tap.
 */
@Injectable()
export class ResellerFlow {
  constructor(
    private readonly api: AuthApiClient,
    private readonly billing: BillingApiClient,
    private readonly tenant: TenantApiClient,
    private readonly access: ChatAccess,
    private readonly campaigns: ResellerCampaignFlow,
  ) {}

  /**
   * May this chat administer the reseller whose bot it is?
   *
   * The one question the bot cannot answer for itself, and the router asks it
   * before drawing the member menu. A failure is `false` and not an error: a
   * customer's menu must not break because `tenant-service` is down.
   */
  async canAdminister(ctx: ChatContext, accessToken: string): Promise<boolean> {
    if (!this.tenant.isConfigured) return false;
    const verdict = await this.tenant.access(ctx.integration.tenantId, {
      lang: ctx.lang,
      accessToken,
    });
    return Boolean(verdict.ok && verdict.data?.canRead);
  }

  /** The panel's own menu. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    return {
      // The bulk-message row waits on `NOTIFICATION_API_BASE_URL` alone: who
      // may actually start one is the door's answer, asked by that flow on the
      // screen that offers the write (`F-313-b`), not guessed at here.
      view: resellerMenu(this.campaigns.isConfigured),
      nextState: { flow: 'reseller', step: 'reseller.home', data: {} },
    };
  }

  async handle(ctx: ChatContext, state: NavState, actionId: string | null): Promise<FlowResult> {
    if (actionId === ACTIONS.resellerUsers) return this.users(ctx, undefined, 1);
    if (actionId === ACTIONS.resellerAllUsers) return this.users(ctx, undefined, 1);
    if (actionId === ACTIONS.resellerRevenue) return this.revenue(ctx);
    // The broadcast is a conversation of its own (`F-313-b`): this row opens
    // it, and the state it hands back is that flow's, not this one's.
    if (actionId === ACTIONS.resellerCampaigns) return this.campaigns.start(ctx);

    if (actionId?.startsWith(RESELLER_PAGE_PREFIX)) {
      const page = Number(actionId.slice(RESELLER_PAGE_PREFIX.length));
      return this.users(ctx, state.data.q, Number.isFinite(page) && page > 0 ? page : 1);
    }
    if (actionId?.startsWith(RESELLER_UNBLOCK_PREFIX)) {
      return this.setBlocked(ctx, actionId.slice(RESELLER_UNBLOCK_PREFIX.length), false);
    }
    if (actionId?.startsWith(RESELLER_BLOCK_PREFIX)) {
      const userId = actionId.slice(RESELLER_BLOCK_PREFIX.length);
      // The same payload asks and answers: the first tap arrives on the
      // customer's screen, the second on the confirmation. The step is what
      // separates them, so a stale keyboard blocks nobody — it lands back on
      // the question (the pattern `accounts.flow.ts` removal uses).
      return state.step === 'reseller.block.confirm' && state.data.target === userId
        ? this.setBlocked(ctx, userId, true)
        : this.confirmBlock(ctx, state, userId);
    }
    if (actionId?.startsWith(RESELLER_USER_PREFIX)) {
      return this.user(ctx, state, actionId.slice(RESELLER_USER_PREFIX.length));
    }

    // Free text on the customer list is the search box this chat does not
    // have. Anywhere else it is an answer to a screen that asked nothing.
    if (actionId === null && state.step === 'reseller.users') return this.search(ctx, ctx.text);

    return { view: say('reseller.pickOne', { key: BotKeys.common.pickOne }), nextState: state };
  }

  /** What they typed, once it is long enough to be a search and not a dump. */
  private search(ctx: ChatContext, text: string | undefined): Promise<FlowResult> {
    const q = (text ?? '').trim();
    if (q.length < MIN_SEARCH_LENGTH) {
      return Promise.resolve({
        view: say('reseller.users.short', { key: BotKeys.reseller.searchTooShort }),
        nextState: { flow: 'reseller', step: 'reseller.users', data: {} },
      });
    }
    return this.users(ctx, q, 1);
  }

  /** One page of the reseller's customers, narrowed by `q` when there is one. */
  private async users(ctx: ChatContext, q: string | undefined, page: number): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const listed = await this.api.resellerUsers(
      ctx.integration.tenantId,
      { q, page, pageSize: USERS_PER_PAGE },
      this.ctxFor(ctx, accessToken),
    );
    if (!listed.ok || !listed.data) {
      return { view: say('reseller.users.failed', { raw: listed.msg }), nextState: null };
    }

    return {
      view: resellerUsersView(listed.data, q),
      // The search and the page are kept so that the *next* screen can re-read
      // this same page: a customer is opened by re-listing what the reseller
      // was looking at and finding the row, never by trusting the button. A
      // page tap carries its own number, which is what advances this.
      nextState: {
        flow: 'reseller',
        step: 'reseller.users',
        data: { page: String(page), ...(q ? { q } : {}) },
      },
    };
  }

  /**
   * One customer, re-read rather than taken off the button: the list may be
   * minutes old, and a payload is input, not a fact. The page is searched by
   * id so the answer is `auth-api`'s own row — including a status that has
   * changed since the list was drawn.
   */
  private async user(ctx: ChatContext, state: NavState, userId: string): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const found = await this.find(ctx, state, userId, accessToken);
    if (!found) return this.gone(state);

    const verdict = await this.tenant.access(ctx.integration.tenantId, {
      lang: ctx.lang,
      accessToken,
    });

    return {
      view: resellerUserView(
        found,
        STATUS_KEY[found.status],
        day(found.createdAt),
        Boolean(verdict.ok && verdict.data?.canWrite),
      ),
      nextState: {
        flow: 'reseller',
        step: 'reseller.user',
        data: { ...state.data, target: userId },
      },
    };
  }

  /** The question, with the customer's name in it — never just "are you sure?". */
  private async confirmBlock(ctx: ChatContext, state: NavState, userId: string): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const found = await this.find(ctx, state, userId, accessToken);
    if (!found) return this.gone(state);

    return {
      view: resellerBlockConfirmView(found),
      nextState: {
        flow: 'reseller',
        step: 'reseller.block.confirm',
        data: { ...state.data, target: userId },
      },
    };
  }

  /**
   * Block, or lift the block.
   *
   * Whether this caller may is `auth-api`'s answer and not this screen's: the
   * button was drawn on the door's verdict, and the route asks the door again.
   * A refusal — a suspended reseller, a seat revoked between the two taps, a
   * platform-banned account — arrives as an already-translated sentence.
   */
  private async setBlocked(ctx: ChatContext, userId: string, blocked: boolean): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const call = this.ctxFor(ctx, accessToken);
    const result = blocked
      ? await this.api.blockResellerUser(ctx.integration.tenantId, userId, call)
      : await this.api.unblockResellerUser(ctx.integration.tenantId, userId, call);

    if (!result.ok || !result.data) {
      return { view: say('reseller.block.failed', { raw: result.msg }), nextState: null };
    }
    return {
      view: say(blocked ? 'reseller.blocked' : 'reseller.unblocked', {
        key: blocked ? BotKeys.reseller.blocked : BotKeys.reseller.unblocked,
        values: { name: result.data.fullName },
      }),
      nextState: null,
    };
  }

  /** Both figures for billing's own default window (F-311-b). */
  private async revenue(ctx: ChatContext): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const totals = await this.billing.resellerRevenue(ctx.integration.tenantId, {
      lang: ctx.lang,
      accessToken,
      platform: ctx.platform,
      botTenantId: ctx.integration.tenantId,
    });
    if (!totals.ok || !totals.data) {
      return { view: say('reseller.revenue.failed', { raw: totals.msg }), nextState: null };
    }
    return {
      view: resellerRevenueView({ ...totals.data, from: day(totals.data.from), to: day(totals.data.to) }),
      nextState: null,
    };
  }

  /**
   * That customer, out of the page the reseller is looking at.
   *
   * `auth-api` has no "read one user" route and should not grow one for this:
   * a reseller reads its customers as a page, and a lookup that took an id
   * straight from a button would be a second, narrower door onto the same
   * data. Re-listing the remembered page keeps the door exactly where F-311-a
   * put it, gives the screen a status that is current rather than the one the
   * list was drawn with, and answers nothing at all for an id that was never
   * on it — including one from another tenant.
   */
  private async find(
    ctx: ChatContext,
    state: NavState,
    userId: string,
    accessToken: string,
  ): Promise<ResellerUser | null> {
    const listed = await this.api.resellerUsers(
      ctx.integration.tenantId,
      { q: state.data.q, page: pageOf(state), pageSize: USERS_PER_PAGE },
      this.ctxFor(ctx, accessToken),
    );
    return (listed.ok && listed.data?.items.find((u) => u.id === userId)) || null;
  }

  /** Back to the list, having said that the row is not there any more. */
  private gone(state: NavState): FlowResult {
    return {
      view: say('reseller.user.gone', { key: BotKeys.common.tryAgain }),
      nextState: { flow: 'reseller', step: 'reseller.users', data: state.data },
    };
  }

  /** Every `auth-api` call from this flow, in one shape (`accounts.flow.ts`'s reason). */
  private ctxFor(ctx: ChatContext, accessToken: string) {
    return {
      chatId: ctx.chatId,
      lang: ctx.lang,
      platform: ctx.platform,
      tenantId: ctx.integration.tenantId,
      accessToken,
    };
  }

  private signedOut(): FlowResult {
    return { view: say('reseller.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}

/**
 * The day part of an ISO timestamp. Spelling, not formatting: the bot picks no
 * calendar and no numerals — `i18n` owns both (§1.5) — it only stops showing a
 * customer's join date to the millisecond.
 */
export function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Which page the remembered list was on; anything unreadable is the first. */
function pageOf(state: NavState): number {
  const page = Number(state.data.page);
  return Number.isFinite(page) && page > 0 ? page : 1;
}
