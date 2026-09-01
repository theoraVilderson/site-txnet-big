import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionStore } from './session.store';
import { SessionRevokedReason } from '@prisma/client';
import { randomUUID } from 'crypto';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
  ) {}

  async createSession(
    userId: string,
    ip: string,
    userAgent: string,
    options?: {
      isImpersonated?: boolean;
      impersonationSessionId?: string;
      switchedFromUserId?: string;
      expiresInSec?: number;
    },
  ) {
    const sessionId = randomUUID();
    const refreshToken = this.tokens.newRefreshToken();
    const refreshTokenHash = this.tokens.refreshHash(refreshToken);
    const expiresInSec = options?.expiresInSec ?? 30 * 24 * 60 * 60;
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);

    const session = await this.prisma.session.create({
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

    await this.sessions.register(sessionId, userId, expiresInSec);
    return { session, refreshToken };
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
