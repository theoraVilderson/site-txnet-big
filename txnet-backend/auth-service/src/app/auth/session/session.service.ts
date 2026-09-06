import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionStore } from './session.store';
import { Prisma, SessionRevokedReason } from '@prisma/client';
import { randomUUID } from 'crypto';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
  ) {}

  /**
   * Creates the session row and its Redis liveness marker.
   *
   * Pass `tx` to write the row inside a caller's transaction — the marker is
   * then *not* written here. Postgres is the record and Redis only the
   * liveness cache (identity/invariants.md #8), so a marker must never appear
   * for a row that has not committed: the returned `activateCache` is the
   * caller's hook to write it once the transaction has, and it is a no-op on
   * the non-transactional path where the marker is already in place.
   */
  async createSession(
    userId: string,
    ip: string,
    userAgent: string,
    options?: {
      isImpersonated?: boolean;
      impersonationSessionId?: string;
      switchedFromUserId?: string;
      expiresInSec?: number;
      /**
       * The switch scope this session is minted on (ADR-0015) — the browser or
       * the chat the request arrived from. Left unset only where there is
       * genuinely no scope: an impersonation session, which an admin holds on
       * the platform's behalf and which no switch group ever contains.
       *
       * Every other caller must pass it, including `refresh`, which re-mints an
       * existing session and has to carry the old row's value forward.
       */
      scopeKey?: string | null;
      tx?: Prisma.TransactionClient;
    },
  ) {
    const sessionId = randomUUID();
    const refreshToken = this.tokens.newRefreshToken();
    const refreshTokenHash = this.tokens.refreshHash(refreshToken);
    const expiresInSec = options?.expiresInSec ?? 30 * 24 * 60 * 60;
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);
    const db = options?.tx ?? this.prisma;

    const session = await db.session.create({
      data: {
        id: sessionId,
        userId,
        refreshTokenHash,
        ipAddress: ip,
        userAgent,
        expiresAt,
        isImpersonated: options?.isImpersonated ?? false,
        impersonationSessionId: options?.impersonationSessionId,
        switchedFromUserId: options?.switchedFromUserId,
        scopeKey: options?.scopeKey ?? null,
      },
    });

    if (!options?.tx) {
      await this.sessions.register(sessionId, userId, expiresInSec);
      const noop = async (): Promise<void> => undefined;
      return { session, refreshToken, activateCache: noop };
    }

    return {
      session,
      refreshToken,
      activateCache: () => this.sessions.register(sessionId, userId, expiresInSec),
    };
  }

  async revokeSession(sessionId: string, reason: SessionRevokedReason) {
    const session = await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: reason },
      select: { userId: true },
    });
    await this.sessions.drop(sessionId, session.userId);
  }

  async revokeAllSessionsForUser(userId: string, reason: SessionRevokedReason) {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.sessions.dropAllForUser(userId);
  }

  /**
   * Revoke this account's live sessions **on one surface only** (F-0208).
   *
   * The narrow version of the call above, and the narrowness is the whole
   * point. Since ADR-0015 a switch group belongs to a browser or a chat, so
   * removing an account from one group is not a statement about the account —
   * it is a statement about that one place. Revoking globally here would let
   * whoever holds a browser sign the account out of a Telegram chat they have
   * no authority over, which is a denial of service dressed as a cleanup.
   *
   * Sessions with no `scopeKey` (impersonation, and anything minted before the
   * column existed) match no scope and are therefore never touched here.
   *
   * The Redis markers are dropped one by one rather than through
   * `dropAllForUser`: that helper is keyed on the user, and the account keeps
   * live sessions in other scopes that must stay usable.
   */
  async revokeSessionsForUserInScope(
    userId: string,
    scopeKey: string,
    reason: SessionRevokedReason,
  ) {
    const doomed = await this.prisma.session.findMany({
      where: { userId, scopeKey, revokedAt: null },
      select: { id: true },
    });
    if (doomed.length === 0) return 0;

    await this.prisma.session.updateMany({
      where: { id: { in: doomed.map((session) => session.id) } },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    for (const session of doomed) {
      await this.sessions.drop(session.id, userId);
    }
    return doomed.length;
  }
}
