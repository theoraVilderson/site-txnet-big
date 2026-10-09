import {
  RedisTtl,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerActor,
  SupportConsentRefused,
  tenantTransaction,
} from '@txnet-backend/shared-core';
import type { Prisma } from '@prisma/client';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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
    private readonly access: ResellerAccess,
  ) {}

  /**
   * The platform's staff become a reseller's user (F-117-e, ADR-0104 (4)(5),
   * catalog §3.6 layer 6): `POST /api/auth/tenants/:tenantId/users/:userId/impersonate`.
   * Admitted only by the consent door with capability `staffWrite`, the staff
   * holding `platform.impersonate` (AC-1-d, ADR-0135) — a live
   * `act` consent, or the caller's own emergency entry — which also records the
   * request in the reseller's trail. The session ends no later than what
   * admitted it (and never later than the 30 minutes), is tied to it, so a
   * revoke or an early end kills it at once (`ImpersonationLeash`), and its
   * audit row is in the reseller's own log.
   */
  async startForReseller(
    actor: ResellerActor,
    tenantId: string,
    targetUserId: string,
    reasonNote: string,
    ip: string,
    userAgent: string,
    now = new Date(),
  ) {
    if (!reasonNote || reasonNote.trim().length < 10) {
      throw new BadRequestException('Reason note must be at least 10 characters');
    }
    // The admin is a user of the platform's tenant: read before the reseller's scope opens.
    const admin = await this.prisma.user.findUnique({ where: { id: actor.userId }, include: { role: true } });
    try {
      return await this.access.asStaff('platform.impersonate').runIncludingPlatform(actor, tenantId, 'staffWrite', async (admitted) => {
        if (admitted.as !== 'staff') throw new ForbiddenException('Only the platform impersonates here');
        const target = await this.prisma.user.findUnique({
          where: { id: targetUserId },
          include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
        });
        const leftSec = admitted.support ? Math.floor((admitted.support.endsAt.getTime() - now.getTime()) / 1000) : IMPERSONATION_TTL_SEC;
        if (leftSec <= 0) throw new ForbiddenException('The consent has ended');
        return this.begin(actor.userId, targetUserId, admin, target, reasonNote, ip, userAgent, {
          expiresInSec: Math.min(IMPERSONATION_TTL_SEC, leftSec),
          tenantId: admitted.id,
          ground: {
            consentId: admitted.support?.consentId ?? null,
            emergencyEntryId: admitted.support?.entryId ?? null,
          },
          // Bound to the reseller: its audit log is under RLS (dual audit, §3.6 layer 5).
          transact: (fn) => tenantTransaction(this.prisma, fn),
        });
      });
    } catch (err) {
      if (err instanceof SupportConsentRefused || err instanceof ResellerAccessRefused) {
        if (err.reason === 'reseller_not_found') throw new NotFoundException({ reason: err.reason });
        throw new ForbiddenException({ reason: err.reason });
      }
      throw err;
    }
  }

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

    return this.begin(adminId, targetUserId, admin, target, reasonNote, ip, userAgent, {
      expiresInSec: IMPERSONATION_TTL_SEC,
      transact: (fn) => this.prisma.$transaction(fn),
    });
  }

  private async begin(
    adminId: string,
    targetUserId: string,
    admin: Prisma.UserGetPayload<{ include: { role: true } }> | null,
    target: Prisma.UserGetPayload<{ include: { role: { include: { rolePermissions: { include: { permission: true } } } } } }> | null,
    reasonNote: string,
    ip: string,
    userAgent: string,
    opts: {
      expiresInSec: number;
      /** A reseller's user (F-117-e): whose log the start is written to, and what admitted the platform. */
      tenantId?: string;
      ground?: { consentId: string | null; emergencyEntryId: string | null };
      transact: <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;
    },
  ) {
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
    const result = await opts.transact(async (tx) => {
      const impersonation = await tx.impersonationSession.create({
        data: {
          adminId,
          targetUserId,
          reasonNote,
          adminIpAddress: ip,
          ...(opts.ground ?? {}),
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
          expiresInSec: opts.expiresInSec,
          tx,
        },
      );

      await tx.adminAuditLog.create({
        data: {
          ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
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
      expiresIn: opts.expiresInSec,
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
