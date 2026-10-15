import { Injectable } from '@nestjs/common';
import { BotAction, BotView } from '@txnet-backend/messenger';

import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import { ResellerFlow } from '../flows/reseller.flow';
import { PAYMENT_CONFIRM_MANUAL } from '../flows/transfer-review.flow';
import { ACTIONS, miniApp, view } from '../flows/views';
import { GuideApiClient } from '../guide-api/guide-api.client';
import { BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import { SupportApiClient } from '../support-api/support-api.client';
import { callContextOf, ChatContext } from './nav.types';
import { isRestrictedToken, tokenHolds } from './restricted';

/** F-414-f. Only where tenant-service's guide route is reachable (`GuideApiClient.isConfigured`). */
const guidesRow: BotAction = { id: ACTIONS.guides, label: { key: BotKeys.action.guides } };

/**
 * The menu a chat sees — guest, member or restricted — and which rows it
 * carries. Its own class since F-805-b: the router decides which screen comes
 * next, and this decides what the menu offers, a question each new row asks.
 */
@Injectable()
export class ChatMenu {
  constructor(
    private readonly access: ChatAccess,
    private readonly api: AuthApiClient,
    private readonly billing: BillingApiClient,
    private readonly reseller: ResellerFlow,
    private readonly supportApi: SupportApiClient,
    private readonly guideApi: GuideApiClient,
  ) {}

  /**
   * Which menu this chat sees depends on its session, never on its chat id.
   *
   * It asks `ChatAccess` rather than reading the Redis entry, and the
   * difference is the whole point (ADR-0033): the entry is a local cache of
   * "this chat has a session", and nothing local can know that session was
   * revoked somewhere else — a Mini App logout, an `F-0208` removal, thirty
   * days of silence. `ChatAccess` refreshes, so a refusal both answers the
   * question and drops the dead entry. The cost is one round trip on a menu
   * render, which is what every other authenticated screen already pays.
   */
  async forChat(ctx: ChatContext): Promise<BotView> {
    const token = await this.access.token(ctx);
    if (!token) return guestMenu(this.guideApi.isConfigured);
    // BAN-1-g (ADR-0133): a restricted account sees why, and support.
    if (isRestrictedToken(token)) {
      const me = await this.api.me({ ...callContextOf(ctx), accessToken: token });
      return restrictedMenu(me.ok ? (me.data.restriction?.reason ?? null) : null, this.supportApi.isConfigured);
    }
    // F-311-c: the management row exists only for a chat the door admits
    // (F-311-e). Asked here, on the same token the menu was decided with, and
    // remembered nowhere — this bot serves the reseller's customers too, and
    // they are most of the chats that reach this line.
    const reseller = await this.reseller.canAdminister(ctx, token);
    return memberMenu({
      miniAppUrl: ctx.miniAppUrl,
      topUp: this.billing.isConfigured,
      reseller,
      support: this.supportApi.isConfigured,
      guides: this.guideApi.isConfigured,
      // F-805-b: read off the token like the restriction — a menu row, never a boundary.
      transfers: this.billing.isConfigured && tokenHolds(token, PAYMENT_CONFIRM_MANUAL),
    });
  }
}

/**
 * The signed-out menu: the two things an anonymous chat can do, plus the way
 * to ask what any of it means. Sign-in leads, because a returning user is the
 * common case and a returning user should not have to read three options.
 */
export function guestMenu(guides = false): BotView {
  return view('menu.guest', { key: BotKeys.menu.guest }, [
    [{ id: ACTIONS.login, label: { key: BotKeys.action.login } }],
    [{ id: ACTIONS.register, label: { key: BotKeys.action.register } }],
    [{ id: ACTIONS.forgot, label: { key: BotKeys.action.forgot } }],
    // F-414-f. A guide is public: a stranger may need the install guide before an account.
    ...(guides ? [[guidesRow]] : []),
    [
      { id: ACTIONS.help, label: { key: BotKeys.action.help } },
      { id: ACTIONS.language, label: { key: BotKeys.action.language } },
    ],
  ]);
}

/** Which optional rows the member menu carries; each is off unless its service is reachable. */
export interface MemberRows {
  /** Optional because `PANEL_BASE_URL` is: no panel published, no row that opens nothing. */
  miniAppUrl?: string;
  topUp?: boolean;
  reseller?: boolean;
  support?: boolean;
  guides?: boolean;
  transfers?: boolean;
}

/** The signed-in menu. Everything past sign-out arrives with §10.4's own rows. */
export function memberMenu({ miniAppUrl, topUp, reseller, support, guides, transfers }: MemberRows = {}): BotView {
  return view('menu.member', { key: BotKeys.menu.member }, [
    ...(miniAppUrl ? [[miniApp(miniAppUrl)]] : []),
    // F-306-a. Only where billing is reachable (`BillingApiClient.isConfigured`).
    ...(topUp ? [[{ id: ACTIONS.topUp, label: { key: BotKeys.action.topUp } }]] : []),
    // F-707-h. Behind the same reachability: billing says whether a wheel runs today.
    ...(topUp ? [[{ id: ACTIONS.wheel, label: { key: BotKeys.action.wheel } }]] : []),
    // F-707-p. Behind the same reachability: billing says which lotteries this user sees.
    ...(topUp ? [[{ id: ACTIONS.lotteries, label: { key: BotKeys.action.lotteries } }]] : []),
    // F-309. Only where support is reachable (`SupportApiClient.isConfigured`).
    ...(support ? [[{ id: ACTIONS.support, label: { key: BotKeys.action.support } }]] : []),
    ...(guides ? [[guidesRow]] : []),
    // F-311-c. The row exists only for a chat the **door** says may administer
    // this bot's reseller (`GET /api/tenants/:id/access`, F-311-e) — never on
    // a rule of the bot's own, and never for the customers this same bot
    // serves, who are the majority of the chats that reach this line.
    ...(reseller ? [[{ id: ACTIONS.reseller, label: { key: BotKeys.action.reseller } }]] : []),
    // F-805-b. Only for a person who may confirm a transfer by hand: the receipts waiting on them.
    ...(transfers ? [[{ id: ACTIONS.transfers, label: { key: BotKeys.action.transfers } }]] : []),
    [{ id: ACTIONS.accounts, label: { key: BotKeys.action.accounts } }],
    // TZ-1-h. Member menu only: a zone is the account's, and a guest has none.
    [{ id: ACTIONS.timeZone, label: { key: BotKeys.action.timeZone } }],
    [
      { id: ACTIONS.help, label: { key: BotKeys.action.help } },
      { id: ACTIONS.language, label: { key: BotKeys.action.language } },
    ],
    [{ id: ACTIONS.logout, label: { key: BotKeys.action.logout } }],
  ]);
}

/**
 * A restricted account's menu (BAN-1-g, ADR-0133): why, and the way to
 * support — plus its other accounts and sign-out, which are its own. Nothing
 * a gate would refuse a tap later.
 */
export function restrictedMenu(reason: string | null, support = false): BotView {
  return view(
    'menu.restricted',
    reason ? { key: BotKeys.menu.restricted, values: { reason } } : { key: BotKeys.menu.restrictedNoReason },
    [
      ...(support ? [[{ id: ACTIONS.support, label: { key: BotKeys.action.support } }]] : []),
      [{ id: ACTIONS.accounts, label: { key: BotKeys.action.accounts } }],
      [{ id: ACTIONS.logout, label: { key: BotKeys.action.logout } }],
    ],
  );
}
