import { Injectable, Logger } from '@nestjs/common';
import { SocialPlatform } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { err, ok, safeExecute } from '../../common/response/response.util';
import { leaveGroup } from '../../account-switch/leave-group';
import { AuthClaims } from '../token.service';
import { SessionService } from './session.service';

/** One place the account is signed in, as the panel's session list shows it. */
export type ActiveSession = {
  /** The newest live session there — an opaque handle, never the place key. */
  id: string;
  current: boolean;
  surface: 'web' | SocialPlatform;
  ipAddress: string | null;
  userAgent: string | null;
  /** When the place last refreshed — every refresh mints the row anew. */
  lastActiveAt: string;
};

type LiveRow = {
  id: string;
  scopeKey: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  issuedAt: Date;
};

/**
 * The caller's own active sessions, Telegram-style: see every place the
 * account is signed in, and end any of them but this one (SES-1-a).
 *
 * The unit is the **place** (`scopeKey`, ADR-0015), not the token. A refresh
 * rotates the row on every page load, and a bot chat and its Mini App are one
 * place holding two rows (ADR-0032), so a per-row list would show one device
 * several times and hand out ids that are stale within fifteen minutes. A
 * place is what a person means by "that laptop" or "my Telegram".
 *
 * The place key itself never leaves the service: a browser's is its
 * `device_id` cookie. The handle is the newest row's id, and `terminate`
 * resolves any of the account's rows — a rotated one included — back to its
 * place.
 *
 * Ending a place ends it for good (ADR-0033's "the place, not the token"),
 * which takes two more steps than a revoke:
 *
 * - the account **leaves that place's switch group** (as F-0208 would) — any
 *   member still signed in there could otherwise switch straight back to it
 *   with no credential (F-0207);
 * - on a bot chat, the account's **own link to that chat is removed** — the
 *   chat signs itself back in against it (ADR-0034). A link to that chat held
 *   by another account is never touched. Until the person re-links, notices
 *   and codes stop arriving on that messenger (identity invariant #12).
 *
 * An admin's impersonation session is not the account's own and is neither
 * listed nor ended here.
 */
@Injectable()
export class ActiveSessionsService {
  private readonly logger = new Logger(ActiveSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  async list(claims: AuthClaims) {
    return safeExecute(async () => {
      const [rows, here] = await Promise.all([this.liveRows(claims.sub), this.currentPlace(claims)]);
      const places = byPlace(rows);
      const sessions: ActiveSession[] = [];
      for (const [place, newest] of places) {
        sessions.push({
          id: newest.id,
          current: place === here,
          surface: surfaceOf(newest.scopeKey),
          ipAddress: newest.ipAddress,
          userAgent: newest.userAgent,
          lastActiveAt: newest.issuedAt.toISOString(),
        });
      }
      // `byPlace` keeps the newest-first order; only the current place moves.
      sessions.sort((a, b) => Number(b.current) - Number(a.current));
      return ok({ sessions }, 'auth.sessionsListed');
    });
  }

  /** End the place the session `id` belongs to — any of the caller's rows, rotated or not. */
  async terminate(claims: AuthClaims, id: string) {
    return safeExecute(async () => {
      const row = await this.prisma.session.findFirst({
        where: { id, userId: claims.sub },
        select: { id: true, scopeKey: true, revokedAt: true },
      });
      // Someone else's id and no id at all are one answer: this route is not
      // a way to learn which session ids exist.
      if (!row) return err('auth.sessionNotFound');
      if (placeOf(row) === (await this.currentPlace(claims))) return err('auth.sessionIsCurrent');

      await this.endPlace(claims.sub, row);
      return ok({ terminated: 1 }, 'auth.sessionTerminated');
    });
  }

  /** Telegram's "terminate all other sessions": every place but the caller's. */
  async terminateOthers(claims: AuthClaims) {
    return safeExecute(async () => {
      const [rows, here] = await Promise.all([this.liveRows(claims.sub), this.currentPlace(claims)]);
      let terminated = 0;
      for (const [place, newest] of byPlace(rows)) {
        if (place === here) continue;
        await this.endPlace(claims.sub, { ...newest, revokedAt: null });
        terminated += 1;
      }
      return ok({ terminated }, 'auth.otherSessionsTerminated');
    });
  }

  private liveRows(userId: string): Promise<LiveRow[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() }, isImpersonated: false },
      select: { id: true, scopeKey: true, ipAddress: true, userAgent: true, issuedAt: true },
      orderBy: { issuedAt: 'desc' },
    });
  }

  /** The place this request was made from, as `placeOf` names it. */
  private async currentPlace(claims: AuthClaims): Promise<string> {
    const row = await this.prisma.session.findUnique({
      where: { id: claims.sessionId },
      select: { id: true, scopeKey: true },
    });
    return placeOf(row ?? { id: claims.sessionId, scopeKey: null });
  }

  private async endPlace(
    userId: string,
    row: { id: string; scopeKey: string | null; revokedAt: Date | null },
  ): Promise<void> {
    // No place to end (impersonation's kind, or minted before ADR-0015): the
    // row is all there is.
    if (!row.scopeKey) {
      if (!row.revokedAt) await this.sessionService.revokeSession(row.id, 'user_logout');
      return;
    }
    const scopeKey = row.scopeKey;

    // Out of the group first, then the sessions — F-0208's order, so no
    // moment shows the account signed out there and still switchable to.
    const member = await this.prisma.linkedAccountMember.findUnique({
      where: { scopeKey_userId: { scopeKey, userId } },
      select: { id: true, groupId: true },
    });
    if (member) await leaveGroup(this.prisma, member);

    const chat = botChatOf(scopeKey);
    if (chat) {
      await this.prisma.linkedBotAccount.deleteMany({
        where: { userId, platform: chat.platform, platformUserId: chat.chatId },
      });
    }

    const revoked = await this.sessionService.revokeSessionsForUserInScope(userId, scopeKey, 'user_logout');
    this.logger.log(
      `sessions: user=${userId} ended a ${surfaceOf(scopeKey)} place from another device — ${revoked} session(s) revoked${member ? ', left its group' : ''}${chat ? ', chat unlinked' : ''}`,
    );
  }
}

/** A place's name for grouping: its scope, or the row itself when it has none. */
function placeOf(row: { id: string; scopeKey: string | null }): string {
  return row.scopeKey ?? `row:${row.id}`;
}

/** Newest row per place, in the newest-first order the rows came in. */
function byPlace(rows: LiveRow[]): Map<string, LiveRow> {
  const places = new Map<string, LiveRow>();
  for (const row of rows) {
    const place = placeOf(row);
    if (!places.has(place)) places.set(place, row);
  }
  return places;
}

/** `bot:<tenantId>:<platform>:<chatId>` (`botScopeKey`), or null for a browser. */
function botChatOf(scopeKey: string | null): { platform: SocialPlatform; chatId: string } | null {
  const parts = scopeKey?.split(':') ?? [];
  if (parts.length !== 4 || parts[0] !== 'bot') return null;
  const platform = parts[2];
  if (platform !== SocialPlatform.telegram && platform !== SocialPlatform.bale) return null;
  return { platform, chatId: parts[3] };
}

function surfaceOf(scopeKey: string | null): ActiveSession['surface'] {
  return botChatOf(scopeKey)?.platform ?? 'web';
}
