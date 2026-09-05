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
}
