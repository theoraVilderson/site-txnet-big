import { RedisTtl } from '@txnet-backend/shared-core';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../auth/token.service';
import { SessionService } from '../auth/session/session.service';
import { SessionStore } from '../auth/session/session.store';

/**
 * An impersonated session is short-lived by design (invariant #7).
 *
 * From the catalogue rather than a private const (F-078): a number an
 * invariant is written about should not live somewhere no catalogue can see.
 */
const IMPERSONATION_TTL_SEC = RedisTtl.impersonation;

@Injectable()
export class ImpersonationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly sessionService: SessionService,
    private readonly sessions: SessionStore,
  ) {}

  async startImpersonation(
    adminId: string,
    targetUserId: string,
    reasonNote: string,
    ip: string,
    userAgent: string,
  ) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      include: { role: true },
    });
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: {
        role: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    });

    if (!admin || !target) throw new BadRequestException('User not found');
    if (target.status !== 'active')
      throw new BadRequestException('Target user is not active');
    if (
      target.roleId === admin.roleId ||
      this.isRoleHigher(target.role, admin.role)
    ) {
      throw new ForbiddenException('You cannot impersonate this user');
    }
    if (!reasonNote || reasonNote.trim().length < 10) {
      throw new BadRequestException(
        'Reason note must be at least 10 characters',
      );
    }

    // The session row is written on `tx` alongside the impersonation and audit
    // rows: invariant #7 requires impersonated access to always carry an audit
    // entry, which only holds if a failed audit write takes the session with
    // it. Committing the session separately would leave an unaudited
    // impersonated session behind whenever the audit insert failed.
    const result = await this.prisma.$transaction(async (tx) => {
      const impersonation = await tx.impersonationSession.create({
        data: {
          adminId,
          targetUserId,
          reasonNote,
          adminIpAddress: ip,
        },
      });

      const { session, activateCache } = await this.sessionService.createSession(
        targetUserId,
        ip,
        userAgent,
        {
          isImpersonated: true,
          impersonationSessionId: impersonation.id,
          switchedFromUserId: adminId,
          expiresInSec: IMPERSONATION_TTL_SEC,
          tx,
        },
      );

      await tx.adminAuditLog.create({
        data: {
          adminId,
          action: 'user_impersonate_start',
          targetEntityType: 'user',
          targetEntityId: targetUserId,
          newValue: { reasonNote, sessionId: session.id },
          adminIpAddress: ip,
        },
      });

      return { impersonation, session, activateCache };
    });

    // Only now that the rows are committed does the session become live.
    await result.activateCache();

    const accessToken = this.tokens.signImpersonatedToken(
      target,
      result.session.id,
      adminId,
    );

    return {
      accessToken,
      expiresIn: IMPERSONATION_TTL_SEC,
    };
  }

  async endImpersonation(sessionId: string, adminId: string, ip: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { impersonationSession: true },
    });
    if (!session || !session.isImpersonated) {
      throw new BadRequestException('Not an impersonation session');
    }
    if (session.switchedFromUserId !== adminId) {
      throw new ForbiddenException('You are not allowed to end this session');
    }

    await this.prisma.$transaction([
      this.prisma.session.update({
        where: { id: sessionId },
        data: { revokedAt: new Date(), revokedReason: 'impersonation_ended' },
      }),
      this.prisma.impersonationSession.update({
        where: { id: session.impersonationSessionId! },
        data: { endedAt: new Date() },
      }),
      this.prisma.adminAuditLog.create({
        data: {
          adminId,
          action: 'user_impersonate_end',
          targetEntityType: 'user',
          targetEntityId: session.userId,
          newValue: { sessionId },
          adminIpAddress: ip,
        },
      }),
    ]);

    // The revocation is already committed above, in the same transaction as
    // the audit row. All that is left is the Redis marker — going back through
    // `revokeSession` here would re-run the Postgres update a second time,
    // overwriting `revokedAt` outside that transaction.
    await this.sessions.drop(sessionId, session.userId);
  }

  private isRoleHigher(roleA: any, roleB: any): boolean {
    const rank: Record<string, number> = {
      SuperAdmin: 4,
      Admin: 3,
      Support: 2,
      User: 1,
    };
    return (rank[roleA.name] ?? 0) >= (rank[roleB.name] ?? 0);
  }
}
