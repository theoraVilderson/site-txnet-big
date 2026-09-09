import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext } from '../conversation/nav.types';
import { BotSessionStore } from './bot-session.store';

/**
 * What the chat is now, or why it is not.
 *
 * The refusal keeps `msg` because every one of them arrives from `auth-api`
 * already translated (ADR-0009) — re-deriving a reason here would be a second
 * opinion about a decision this service does not make.
 */
export interface SwitchOutcome {
  ok: boolean;
  /** Already translated by `auth-api` (ADR-0009) — shown as-is on a refusal. */
  msg: string;
  /** Set only when `ok`: who the chat is now. */
  userId?: string;
  fullName?: string;
}

/**
 * Become another account, and keep the chat's session pointing at it (`F-0207`).
 *
 * Two flows reach this: `accounts.flow.ts`, where the user picked a member off
 * a list, and `account-add.flow.ts`, where an account has just proved itself
 * and the chat should already be on it. The call and the write that follows it
 * live here rather than in either flow because they are **not two steps** —
 * `auth-api` revokes the outgoing session inside the same transaction that
 * mints the incoming one (`audit` invariant #7), so by the time the answer
 * arrives the token the chat still holds is already dead. Storing the new one
 * is not a commit that may be retried; it is the only copy in existence, and a
 * caller that returned early between the two would sign the chat out of both
 * accounts at once.
 *
 * A refusal is left entirely to the caller. "Not a member" is a dead end on
 * the switch screen and a lost convenience after an add, and this class knows
 * neither — it answers `null` and the flow decides what that means.
 */
@Injectable()
export class AccountSwitcher {
  constructor(
    private readonly api: AuthApiClient,
    private readonly sessions: BotSessionStore,
  ) {}

  /**
   * On `ok: false` nothing was stored and the chat is still whoever it was —
   * including when the answer came back successful but carried no refresh
   * token, which is a switch that cannot be kept and so is not one.
   */
  async switchTo(
    ctx: ChatContext,
    accessToken: string,
    userId: string,
  ): Promise<SwitchOutcome> {
    const result = await this.api.switchAccount(
      { userId },
      { chatId: ctx.chatId, lang: ctx.lang, platform: ctx.platform, accessToken },
    );
    if (!result.ok || !result.data?.refreshToken) {
      return { ok: false, msg: result.msg };
    }

    await this.sessions.save(
      ctx.integration,
      ctx.chatId,
      result.data.refreshToken,
    );
    return {
      ok: true,
      msg: result.msg,
      userId: result.data.userId,
      fullName: result.data.fullName,
    };
  }
}
