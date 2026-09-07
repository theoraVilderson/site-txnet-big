import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { AccountSwitcher } from '../session/account-switcher';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import {
  ACCOUNT_ACTION_PREFIX,
  ACTIONS,
  REMOVE_ACTION_PREFIX,
  accountsView,
  removeAccountsView,
  removeConfirmView,
  say,
} from './views';

/**
 * Moving between the accounts one person holds, inside the chat (`F-0210`),
 * and taking one back out of the set (`F-0208`).
 *
 * What is switched here is the **session**, never the link. A chat stays
 * anchored to exactly one `LinkedBotAccount` (identity invariant #12): the
 * Redis entry this flow rewrites is the chat's equivalent of the panel's
 * cookie, and rewriting a cookie is all the panel's switcher does either
 * (`F-0209`). The visible consequence is one tap, and it is the whole trade
 * ADR-0014 records: after `/logout` the one-tap sign-in (ADR-0012) returns to
 * the account this chat is linked to, and reaching the other one is a switch
 * from there.
 *
 * The set itself belongs to **this chat** since ADR-0015. The same person may
 * hold a completely different set in their browser, and nothing on this screen
 * can see it or change it — which is also why removing an account here signs
 * it out here and leaves its other sessions alone.
 *
 * Membership is decided nowhere in this file. `auth-api` answers all three
 * questions — who is in the group, whether this caller may become that member,
 * and whether it may remove one — and every refusal arrives as an
 * already-translated `msg` (ADR-0009).
 */
@Injectable()
export class AccountsFlow {
  constructor(
    private readonly api: AuthApiClient,
    private readonly access: ChatAccess,
    private readonly sessions: BotSessionStore,
    private readonly switcher: AccountSwitcher,
  ) {}

  /**
   * Every `auth-api` call from this flow, in one shape.
   *
   * `platform` is the part that matters and the part easiest to forget: without
   * it `auth-api` cannot name this chat's scope and refuses the call outright
   * (ADR-0015), so it is built here rather than at each call site.
   */
  private ctxFor(ctx: ChatContext, accessToken: string) {
    return {
      chatId: ctx.chatId,
      lang: ctx.lang,
      platform: ctx.platform,
      accessToken,
    };
  }

  /** The group, as one screen. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const group = await this.api.listAccounts(this.ctxFor(ctx, accessToken));
    if (!group.ok || !group.data) {
      return { view: say('accounts.failed', { raw: group.msg }), nextState: null };
    }

    return {
      view: accountsView(group.data.current, group.data.members),
      // A single screen, so there is no step to advance and no progress to
      // count (`flows/steps.ts`). The state exists only so a *typed* answer
      // can be matched back to a choice on a degraded rendering.
      nextState: { flow: 'accounts', step: 'accounts.pick', data: {} },
    };
  }

  async handle(
    ctx: ChatContext,
    state: NavState,
    actionId: string | null,
  ): Promise<FlowResult> {
    if (actionId === ACTIONS.accountRemove) return this.pickToRemove(ctx, state);

    if (actionId?.startsWith(REMOVE_ACTION_PREFIX)) {
      const userId = actionId.slice(REMOVE_ACTION_PREFIX.length);
      // The same payload confirms and executes: the first tap arrives on the
      // pick screen and asks, the second arrives on the confirm screen and
      // does it. The step is what separates them, so a stale keyboard cannot
      // remove anything — it lands back on the question.
      return state.step === 'accounts.remove.confirm' && state.data.target === userId
        ? this.removeNow(ctx, userId)
        : this.confirmRemoval(ctx, userId);
    }

    if (!actionId?.startsWith(ACCOUNT_ACTION_PREFIX)) {
      // Free text on a screen that is nothing but choices. The router turns a
      // view with words and no actions into a hint on the screen the user is
      // actually on, so this re-asks rather than emptying the chat.
      return { view: say('accounts.pickOne', { key: 'bot.common.pickOne' }), nextState: state };
    }
    return this.switchTo(ctx, state, actionId.slice(ACCOUNT_ACTION_PREFIX.length));
  }

  /**
   * Become that member.
   *
   * The call and the write that keeps it live in `AccountSwitcher`, because
   * they are one step and not two (`audit` invariant #7 — see that class).
   * What is left here is the only part that is this screen's: where a refusal
   * puts the user.
   */
  private async switchTo(
    ctx: ChatContext,
    state: NavState,
    userId: string,
  ): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const switched = await this.switcher.switchTo(ctx, accessToken, userId);
    if (!switched.ok) {
      // Not a member, another tenant, a suspended account — one key, on
      // purpose (`F-0207`). Keep the user on the list they were reading.
      return { view: say('accounts.refused', { raw: switched.msg }), nextState: state };
    }

    return {
      view: say('accounts.switched', {
        key: 'bot.accounts.switched',
        values: { name: switched.fullName },
      }),
      nextState: null,
    };
  }

  /** "Which one should go?" — the group again, read as a removal list. */
  private async pickToRemove(
    ctx: ChatContext,
    state: NavState,
  ): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    // Re-read rather than reusing what `start` rendered: the screen may be
    // minutes old, and removing from a stale list is how someone removes the
    // account that happens to have taken the row they remember tapping.
    const group = await this.api.listAccounts(this.ctxFor(ctx, accessToken));
    if (!group.ok || !group.data) {
      return { view: say('accounts.failed', { raw: group.msg }), nextState: state };
    }

    return {
      view: removeAccountsView(group.data.current, group.data.members),
      nextState: { flow: 'accounts', step: 'accounts.remove.pick', data: {} },
    };
  }

  /** Name the account out loud before doing it. */
  private async confirmRemoval(
    ctx: ChatContext,
    userId: string,
  ): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const group = await this.api.listAccounts(this.ctxFor(ctx, accessToken));
    if (!group.ok || !group.data) {
      return { view: say('accounts.failed', { raw: group.msg }), nextState: null };
    }

    const isSelf = group.data.current.userId === userId;
    const target = isSelf
      ? group.data.current
      : group.data.members.find((m) => m.userId === userId);
    if (!target) {
      // Gone between the two taps — removed from the panel, or switched away
      // from. Say the ordinary refusal rather than inventing a name.
      return {
        view: say('accounts.removeRefused', { key: 'bot.accounts.removeFailed' }),
        nextState: null,
      };
    }

    return {
      view: removeConfirmView(target, isSelf),
      nextState: {
        flow: 'accounts',
        step: 'accounts.remove.confirm',
        data: { target: userId },
      },
    };
  }

  /**
   * Do it.
   *
   * Removing the chat's own account is a sign-out here, so the stored refresh
   * token is dropped: `auth-api` has already revoked the session behind it
   * (`F-0208`), and a chat holding a dead token would answer every later tap
   * with a failed refresh instead of the sign-in offer it should be showing.
   */
  private async removeNow(
    ctx: ChatContext,
    userId: string,
  ): Promise<FlowResult> {
    const accessToken = await this.access.token(ctx);
    if (!accessToken) return this.signedOut();

    const before = await this.api.listAccounts(this.ctxFor(ctx, accessToken));
    const isSelf = before.ok && before.data?.current.userId === userId;

    const result = await this.api.removeAccount(
      { userId },
      this.ctxFor(ctx, accessToken),
    );
    if (!result.ok) {
      return {
        view: say('accounts.removeRefused', { raw: result.msg }),
        nextState: null,
      };
    }

    if (isSelf) {
      await this.sessions.clear(ctx.platform, ctx.chatId);
      return {
        view: say('accounts.removedSelf', { key: 'bot.accounts.removedSelf' }),
        nextState: null,
      };
    }

    return {
      view: say('accounts.removed', { key: 'bot.accounts.removed' }),
      nextState: null,
    };
  }

  /**
   * The session died between opening the menu and tapping on it — revoked from
   * the panel, or switched away from on another surface. Say so plainly; the
   * router attaches the (now guest) menu.
   */
  private signedOut(): FlowResult {
    return {
      view: say('accounts.signedOut', { key: 'bot.common.notSignedIn' }),
      nextState: null,
    };
  }
}
