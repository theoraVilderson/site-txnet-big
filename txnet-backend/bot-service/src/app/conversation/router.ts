import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BotAction,
  BotPlatform,
  BotView,
  BotViewRenderer,
  parseStart,
  parseStartPayload,
} from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BotCopy } from '../locale/bot-copy';
import { ChatLanguage } from '../locale/chat-language';
import { LocaleService } from '../locale/locale.service';
import { BotSessionStore } from '../session/bot-session.store';
import { AccountAddFlow } from '../flows/account-add.flow';
import { AccountsFlow } from '../flows/accounts.flow';
import { ForgotFlow } from '../flows/forgot.flow';
import { LoginFlow } from '../flows/login.flow';
import { RegisterFlow } from '../flows/register.flow';
import { OtpStep } from '../flows/otp.step';
import {
  ACTIONS,
  LANGUAGE_ACTION_PREFIX,
  back,
  guestMenu,
  helpView,
  languageView,
  memberMenu,
  MINI_APP_PARAM,
  say,
  signOutAllConfirmView,
} from '../flows/views';
import { progressOf, summaryOf } from '../flows/steps';
import { ChatAccess } from '../session/chat-access';
import { ConversationStore } from './conversation.store';
import { callContextOf, ChatContext, FlowResult, NavState } from './nav.types';

/** The one step that belongs to no flow: the panel drives it (`F-0203`). */
export const PANEL_LINK_STEP = 'panelLink.contact';

/**
 * How many steps back a user can walk. Deep enough to cover the longest flow
 * (register, six questions) and bounded so a chat that loops cannot grow its
 * Redis entry without limit.
 */
export const HISTORY_LIMIT = 12;

/**
 * One update in, one screen out.
 *
 * The router owns the things that are true in every flow — `/start`, cancel,
 * sign-out, and reading a *typed* answer back to a choice — and delegates the
 * rest to the flow the chat is in. It decides nothing about accounts: every
 * such question is an `auth-api` call inside a flow (ADR-0009).
 */
@Injectable()
export class ConversationRouter {
  private readonly logger = new Logger(ConversationRouter.name);

  constructor(
    private readonly nav: ConversationStore,
    private readonly sessions: BotSessionStore,
    private readonly renderer: BotViewRenderer,
    private readonly copy: BotCopy,
    private readonly langs: ChatLanguage,
    private readonly locale: LocaleService,
    private readonly api: AuthApiClient,
    private readonly otp: OtpStep,
    private readonly login: LoginFlow,
    private readonly register: RegisterFlow,
    private readonly forgot: ForgotFlow,
    private readonly accounts: AccountsFlow,
    private readonly accountAdd: AccountAddFlow,
    private readonly config: ConfigService,
    private readonly access: ChatAccess,
  ) {}

  /**
   * Decide, then orient. `dispatch` picks the next screen; `decorate` makes
   * that screen answer "where am I, what have I already said, what can I do
   * from here" — centrally, so a flow cannot ship without it.
   */
  async route(ctx: ChatContext): Promise<FlowResult> {
    const state = await this.nav.get(ctx.integration, ctx.chatId);
    const actionId = this.resolveAction(ctx, state);
    const result = await this.dispatch(ctx, state, actionId);
    return this.decorate(ctx, state, actionId, result);
  }

  private async dispatch(
    ctx: ChatContext,
    state: NavState | null,
    actionId: string | null,
  ): Promise<FlowResult> {
    const command = ctx.text?.trim().split(/\s+/)[0];

    // `/start`, with or without a payload, always re-enters at a known screen.
    const startPayload = ctx.text ? parseStart(ctx.text) : null;
    if (startPayload !== null) return this.start(ctx, startPayload);

    if (command === '/logout' || actionId === ACTIONS.logout) {
      return this.logout(ctx);
    }
    if (actionId === ACTIONS.logoutAllAsk) {
      return { view: signOutAllConfirmView(), nextState: null };
    }
    if (actionId === ACTIONS.logoutAll) return this.logoutAll(ctx);
    if (command === '/help' || actionId === ACTIONS.help) return this.help(state);
    if (command === '/lang' || actionId === ACTIONS.language) {
      return this.languages(ctx, state);
    }
    if (actionId?.startsWith(LANGUAGE_ACTION_PREFIX)) {
      return this.chooseLanguage(ctx, state, actionId);
    }
    if (command === '/menu' || actionId === ACTIONS.menu) {
      return { view: await this.menu(ctx), nextState: null };
    }
    if (actionId === ACTIONS.cancel || command === '/cancel') {
      return { view: say('cancelled', { key: 'bot.common.cancelled' }), nextState: null };
    }
    if (actionId === ACTIONS.back) return this.back(ctx, state);

    if (actionId === ACTIONS.accounts) return this.accounts.start(ctx);
    // Reachable from both account screens — the empty one and the full one —
    // so it is dispatched here rather than out of `AccountsFlow.handle`.
    if (actionId === ACTIONS.accountAdd) return this.accountAdd.start(ctx);

    if (actionId === ACTIONS.login) return this.login.start(ctx);
    if (actionId === ACTIONS.register) return this.register.start();
    if (actionId === ACTIONS.forgot) return this.forgot.start();

    if (!state) return this.withoutState(ctx);

    // The panel started this link and is polling `bots/link/status`; the chat's
    // only remaining job is to hand over the contact. Nothing continues here
    // afterwards — the user finishes on the website they started from.
    if (state.step === PANEL_LINK_STEP) {
      const outcome = await this.otp.submitContact(ctx, state);
      return { view: outcome.view, nextState: null };
    }

    switch (state.flow) {
      case 'login':
        return this.login.handle(ctx, state, actionId);
      case 'register':
        return this.register.handle(ctx, state, actionId);
      case 'forgot':
        return this.forgot.handle(ctx, state, actionId);
      case 'accounts':
        return this.accounts.handle(ctx, state, actionId);
      case 'accountAdd':
        return this.accountAdd.handle(ctx, state, actionId);
      default:
        return { view: say('unknown', { key: 'bot.common.unknown' }), nextState: null };
    }
  }

  /**
   * Nothing in Redis. Two very different situations wear the same shape here,
   * and telling them apart is the whole point:
   *
   * - a tap or a fresh chat — show the menu;
   * - free text — the user was *answering* something. Their conversation
   *   expired (`BOT_NAV_TTL_SEC`) or a deploy dropped it, and answering "what
   *   is your full name?" with the guest menu, as if they had said nothing,
   *   is the single most disorienting thing this bot can do. Say so.
   */
  private async withoutState(ctx: ChatContext): Promise<FlowResult> {
    if (!ctx.text?.trim() || ctx.text.trim().startsWith('/')) {
      return { view: await this.menu(ctx), nextState: null };
    }
    return {
      view: say('expired', { key: 'bot.common.expired' }),
      nextState: null,
    };
  }

  /**
   * One step back. The screen is replayed from the breadcrumb rather than
   * rebuilt by the flow: a flow that can render a step it is not currently on
   * is a second copy of the flow, and this way every flow — including every
   * §10.4 flow not yet written — gets Back without writing any.
   */
  private back(ctx: ChatContext, state: NavState | null): FlowResult {
    const previous = state?.history?.[state.history.length - 1];
    if (!previous?.lastView) {
      return { view: say('backGone', { key: 'bot.common.backGone' }), nextState: null };
    }
    return {
      view: bare(previous.lastView),
      nextState: {
        ...previous,
        history: (state?.history ?? []).slice(0, -1),
      },
    };
  }

  /**
   * Help never costs the user their place: mid-conversation it is printed
   * above the question they were on, with that question's own buttons intact.
   * A help screen that ends the conversation punishes curiosity.
   */
  private help(state: NavState | null): FlowResult {
    if (!state?.lastView) return { view: helpView(), nextState: null };
    return {
      view: { ...bare(state.lastView), id: 'help', hint: { key: 'bot.help.body' } },
      nextState: state,
    };
  }

  /**
   * The language chooser. Like `/help`, it keeps the user's place: a chat
   * halfway through registering should not have to start again to be able to
   * read the questions.
   */
  private async languages(
    ctx: ChatContext,
    state: NavState | null,
  ): Promise<FlowResult> {
    const locales = (await this.locale.locales()).map((l) => ({
      code: l.code,
      nativeName: l.native_name || l.name || l.code,
    }));
    if (locales.length < 2) {
      // One language served: offering a choice that has no alternative is
      // noise, so say plainly that there is nothing to switch to.
      return {
        view: say('language.only', { key: 'bot.language.only' }),
        nextState: state,
      };
    }
    return { view: languageView(locales, ctx.lang), nextState: state };
  }

  /**
   * A language was picked. Everything on screen is an i18n key, so the screen
   * the user was on is simply re-sent — in the new language, with its own
   * buttons — rather than the conversation restarting in a language they can
   * now read but a place they have lost.
   */
  private async chooseLanguage(
    ctx: ChatContext,
    state: NavState | null,
    actionId: string,
  ): Promise<FlowResult> {
    const lang = actionId.slice(LANGUAGE_ACTION_PREFIX.length);
    const ok = await this.langs.choose(ctx.integration, ctx.chatId, lang);
    if (!ok) {
      return { view: say('language.unknown', { key: 'bot.common.tryAgain' }), nextState: state };
    }
    // This very reply is already in the new language: the dispatcher renders
    // with `result.lang` when a result carries one, so the confirmation is not
    // written in the language the user just asked to leave.
    if (state?.lastView) {
      return {
        view: { ...bare(state.lastView), hint: { key: 'bot.language.changed' } },
        nextState: state,
        lang,
      };
    }
    return { view: await this.menu(ctx), nextState: null, lang };
  }

  /**
   * Everything a screen needs that no flow should have to remember.
   *
   * 1. **A statement is never a dead end.** A flow that answers with words and
   *    no choices — "please pick one", "I cannot see it yet", or an `auth-api`
   *    rejection — used to leave a chat with nothing on it, sometimes while
   *    pointing at options that were not there. The words become the `hint`
   *    on the screen the user is actually on, which still has its buttons.
   * 2. **The breadcrumb** grows by one whenever a step advances.
   * 3. **Orientation**: which conversation, which step of how many, and what
   *    has been answered so far.
   * 4. **Back**, next to Cancel, from the second step onwards.
   * 5. **A finished conversation lands on the menu**, in the same message —
   *    never on a sentence and an empty chat.
   */
  private async decorate(
    ctx: ChatContext,
    before: NavState | null,
    actionId: string | null,
    result: FlowResult,
  ): Promise<FlowResult> {
    let view = result.view;
    const next = result.nextState;

    if (
      next &&
      before?.lastView &&
      next.step === before.step &&
      !(view.actions ?? []).flat().length
    ) {
      view = { ...bare(before.lastView), id: view.id, hint: view.body };
    }

    if (!next) {
      // Only a screen that offers nothing needs the menu bolted on. One that
      // already has choices — the language chooser, help, the menu itself —
      // has somewhere to go, and replacing its buttons with the menu's would
      // take away the very thing it was opened for.
      if ((view.actions ?? []).flat().length) return { ...result, view };
      const menu = await this.menu(ctx);
      return {
        ...result,
        view: { ...view, footer: menu.body, actions: menu.actions },
      };
    }

    const advanced = !before || before.step !== next.step;
    const history =
      advanced && before && actionId !== ACTIONS.back
        ? [...(before.history ?? []), { ...before, history: [] }].slice(-HISTORY_LIMIT)
        : (next.history ?? []);

    const header = progressOf(next);
    const summary = summaryOf(next);
    view = {
      ...view,
      ...(header ? { header } : {}),
      ...(summary.length ? { summary } : {}),
      ...(history.length ? { actions: withBack(view.actions) } : {}),
    };

    return { ...result, view, nextState: { ...next, history } };
  }

  /**
   * `/start` and its payload (`F-314`). An unrecognised payload lands on the
   * menu rather than failing: it comes from outside, so it is untrusted input
   * and not a command (`bot-app/contract.md`).
   */
  private async start(ctx: ChatContext, payload: string): Promise<FlowResult> {
    const parsed = parseStartPayload(payload);

    // The `F-0203` link token: someone started this from the panel, and the
    // panel is waiting on `bots/link/status`. Finish that, do not open a menu.
    if (parsed.kind === 'link') {
      const resolved = await this.api.linkResolve(
        {
          platform: ctx.platform,
          chatId: ctx.chatId,
          startToken: parsed.token,
          languageCode: ctx.lang,
        },
        callContextOf(ctx),
      );
      if (!resolved.ok || !resolved.data) {
        return { view: say('link.failed', { raw: resolved.msg }), nextState: null };
      }
      if (resolved.data.needsContact) {
        return {
          view: {
            id: 'link.contact',
            body: { key: `otp.botLink.${resolved.data.messageKey}` },
            actions: [
              [
                {
                  id: ACTIONS.shareContact,
                  kind: 'contact',
                  label: { key: 'bot.action.shareContact' },
                },
              ],
            ],
          },
          // No flow of our own: the panel drives this one, and the next thing
          // this chat sends is the contact.
          nextState: { flow: 'login', step: PANEL_LINK_STEP, data: {} },
        };
      }
      return {
        view: say('link.done', { key: `otp.botLink.${resolved.data.messageKey}` }),
        nextState: null,
      };
    }

    if (parsed.kind !== 'none' && parsed.kind !== 'unknown') {
      // buy_/ref_/trial arrive with §10.4's own features; until those exist the
      // payload is remembered by nobody and the user sees the menu.
      this.logger.log(`${ctx.platform}: ${parsed.kind} deep link, not built yet`);
    }

    return { view: await this.menu(ctx), nextState: null };
  }

  /**
   * Sign out of the account this chat is on.
   *
   * ADR-0035: `auth-api` may answer with **another account's session** — the
   * next account this place already holds — in which case the chat keeps it
   * and stays signed in as them. Dropping the entry there would throw away a
   * session that was just minted for this chat and nobody else.
   *
   * Signing out of everything is `ACTIONS.logoutAll`, which lives on the
   * accounts screen behind its own confirmation, not on the main menu.
   */
  private async logout(ctx: ChatContext): Promise<FlowResult> {
    const session = await this.sessions.get(ctx.integration, ctx.chatId);
    if (!session) {
      return {
        view: say('signedOut', { key: 'bot.common.signedOut' }),
        nextState: null,
      };
    }

    const result = await this.api.logout(
      { refreshToken: session.refreshToken },
      callContextOf(ctx),
    );

    const handover = result.ok ? result.data : undefined;
    if (handover?.switchedTo && handover.refreshToken) {
      await this.sessions.save(
        ctx.integration,
        ctx.chatId,
        handover.refreshToken,
      );
      return {
        view: say('signedOutSwitched', {
          key: 'bot.common.signedOutSwitched',
          values: { name: handover.switchedTo.fullName },
        }),
        nextState: null,
      };
    }

    await this.sessions.clear(ctx.integration, ctx.chatId);
    return {
      view: say('signedOut', { key: 'bot.common.signedOut' }),
      nextState: null,
    };
  }

  /**
   * Sign out of every account this chat holds (`F-0211`, ADR-0035).
   *
   * Its own action because it is its own intention. Reached from the accounts
   * screen rather than the main menu, so the destructive one is never the
   * button beside the ordinary one.
   */
  private async logoutAll(ctx: ChatContext): Promise<FlowResult> {
    const session = await this.sessions.get(ctx.integration, ctx.chatId);
    if (session) {
      await this.api.logoutAll(
        { refreshToken: session.refreshToken },
        callContextOf(ctx),
      );
      await this.sessions.clear(ctx.integration, ctx.chatId);
    }
    return {
      view: say('signedOutAll', { key: 'bot.common.signedOutAll' }),
      nextState: null,
    };
  }

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
  private async menu(ctx: ChatContext) {
    const token = await this.access.token(ctx);
    return token ? memberMenu(this.miniAppUrl(ctx.platform)) : guestMenu();
  }

  /**
   * Where the Mini App lives (`F-310`), or nothing.
   *
   * Only the member menu offers it. A chat with no session is one this bot has
   * never signed in, and sending it into a webview to find out whether the
   * messenger vouches for it there is a worse first answer than the sign-in
   * button it already has — the panel's own login screen inside a webview is
   * the thing chat-first exists to avoid making anyone use.
   *
   * The URL carries `?ma=<platform>` because the page cannot work that out for
   * itself: neither messenger injects its `WebApp` global, each serves its own
   * script, and a page that loaded neither found nothing to sign in with
   * (fixed 2026-09-10). It is a hint about which SDK to fetch and **not** a
   * credential — the signature that comes back is still the only thing
   * `/auth/bots/webapp/session` accepts, so a forged marker buys an attacker
   * the wrong script and nothing else.
   */
  private miniAppUrl(platform: BotPlatform): string | undefined {
    const base = this.config.get<string>('PANEL_BASE_URL');
    if (!base) return undefined;
    const url = new URL(base);
    url.searchParams.set(MINI_APP_PARAM, platform);
    return url.toString();
  }

  /**
   * What the user chose: an inline tap, or — on a degraded rendering — the
   * number or the label they typed. `null` means it was free text, which is
   * how a flow tells an answer from a phone number.
   */
  private resolveAction(ctx: ChatContext, state: NavState | null): string | null {
    if (ctx.callbackData) return ctx.callbackData;
    if (!ctx.text || !state?.lastView) return null;
    return this.renderer.matchAction(
      state.lastView,
      this.copy.translator(ctx.lang),
      ctx.text,
    );
  }
}

/**
 * A screen with its decoration taken off, ready to be decorated again.
 *
 * Every stored `lastView` was already oriented once. Replaying it as-is would
 * show a step count and a summary from a conversation that has since moved,
 * which is worse than showing none.
 */
function bare(view: BotView): BotView {
  const { header: _h, summary: _s, hint: _i, footer: _f, ...rest } = view;
  return rest;
}

/** Back, in the same row as Cancel — one row that means "not this way". */
function withBack(actions: BotAction[][] | undefined): BotAction[][] {
  const rows = actions ?? [];
  const at = rows.findIndex((row) => row.some((a) => a.id === ACTIONS.cancel));
  if (at < 0) return [...rows, [back]];
  if (rows[at].some((a) => a.id === ACTIONS.back)) return rows;
  return rows.map((row, i) => (i === at ? [back, ...row] : row));
}
