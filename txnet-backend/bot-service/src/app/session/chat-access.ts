import { Injectable } from '@nestjs/common';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { callContextOf, ChatContext } from '../conversation/nav.types';
import { BotSessionStore } from './bot-session.store';

/**
 * An access token for the chat's own session.
 *
 * The bot keeps a refresh token, exactly as the panel's browser keeps a cookie
 * (`bot-app/contract.md`), and that is all it keeps: an access token lives
 * fifteen minutes and caching one would mean holding a credential in Redis for
 * longer than `auth-api` intends it to exist. So a route behind `AuthGuard` is
 * always two calls — refresh, then the call itself — and this class is the
 * first of the two.
 *
 * **Refreshing rotates.** The refresh token that comes back replaces the
 * stored one before anything else happens; skipping that would sign the chat
 * out on its next message, because the token it still held has been spent.
 * The same rotation is what makes a failure terminal rather than transient: a
 * refresh `auth-api` refuses means the session is gone (revoked elsewhere, a
 * switch performed from the panel, an expired 30 days), so the entry is
 * dropped and the chat is signed out here rather than at some later screen
 * that cannot explain itself.
 */
@Injectable()
export class ChatAccess {
  constructor(
    private readonly api: AuthApiClient,
    private readonly sessions: BotSessionStore,
  ) {}

  /** `null` means this chat has no live session — show it the guest menu. */
  async token(ctx: ChatContext): Promise<string | null> {
    const session = await this.sessions.get(ctx.integration, ctx.chatId);
    if (!session) return null;

    const refreshed = await this.api.refresh(
      { refreshToken: session.refreshToken },
      callContextOf(ctx),
    );
    if (!refreshed.ok || !refreshed.data?.accessToken) {
      await this.sessions.clear(ctx.integration, ctx.chatId);
      return null;
    }

    if (refreshed.data.refreshToken) {
      await this.sessions.save(
        ctx.integration,
        ctx.chatId,
        refreshed.data.refreshToken,
      );
    }
    return refreshed.data.accessToken;
  }
}
