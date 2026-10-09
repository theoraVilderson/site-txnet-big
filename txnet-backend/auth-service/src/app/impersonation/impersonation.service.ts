import {
  holdsPermission,
  RedisTtl,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerActor,
  SupportConsentRefused,
  tenantTransaction,
} from '@txnet-backend/shared-core';
import { TenantType, type Prisma } from '@prisma/client';
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
import { authorityOver, permissionsOf } from '../auth/users/authority';

/**
 * An impersonated session is short-lived by design (invariant #7).
 *
 * From the catalogue rather than a private const (F-078): a number an
 * invariant is written about should not live somewhere no catalogue can see.
 */
const IMPERSONATION_TTL_SEC = RedisTtl.impersonation;

/** A user read with their role's keys — both sides of the authority rule. */
const WITH_KEYS = { role: { include: { rolePermissions: { include: { permission: true } } } } } as const;
type UserWithKeys = Prisma.UserGetPayload<{ include: typeof WITH_KEYS }>;

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
    const admin = await this.prisma.user.findUnique({ where: { id: actor.userId }, include: WITH_KEYS });
    try {
      return await this.access.asStaff('platform.impersonate').runIncludingPlatform(actor, tenantId, 'staffWrite', async (admitted) => {
        if (admitted.as !== 'staff') throw new ForbiddenException('Only the platform impersonates here');
        const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, include: WITH_KEYS });
        const leftSec = admitted.support ? Math.floor((admitted.support.endsAt.getTime() - now.getTime()) / 1000) : IMPERSONATION_TTL_SEC;
        if (leftSec <= 0) throw new ForbiddenException('The consent has ended');
        return this.begin(actor.userId, targetUserId, admin, target, reasonNote, ip, userAgent, {
          expiresInSec: Math.min(IMPERSONATION_TTL_SEC, leftSec),
          authority: { as: 'staff', tenantId: admitted.id },
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
    const admin = await this.prisma.user.findUnique({ where: { id: adminId }, include: WITH_KEYS });
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, include: WITH_KEYS });

    return this.begin(adminId, targetUserId, admin, target, reasonNote, ip, userAgent, {
      expiresInSec: IMPERSONATION_TTL_SEC,
      authority: { as: 'member', tenantId: admin?.tenantId ?? null },
      transact: (fn) => this.prisma.$transaction(fn),
    });
  }

  private async begin(
    adminId: string,
    targetUserId: string,
    admin: UserWithKeys | null,
    target: UserWithKeys | null,
    reasonNote: string,
    ip: string,
    userAgent: string,
    opts: {
      expiresInSec: number;
      /** Who the actor is to the tenant the target is in — `authorityOver`'s inputs (ADR-0103). */
      authority: { as: 'member' | 'staff'; tenantId: string | null };
      /** A reseller's user (F-117-e): whose log the start is written to, and what admitted the platform. */
      tenantId?: string;
      ground?: { consentId: string | null; emergencyEntryId: string | null };
      transact: <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;
    },
  ) {
    if (!admin || !target) throw new BadRequestException('User not found');
    if (target.status !== 'active')
      throw new BadRequestException('Target user is not active');
    // AC-1-h (§3.6 layer 1): the authority rule every act on another person
    // asks (ADR-0103) — a peer holds every key the target holds and one more;
    // never self, never the tenant's owner (ADR-0137, the platform included)
    // — and never anyone holding `*`, whoever asks (`'*'` is held only by a
    // holder of `*`). No name is ranked, so a tenant-made role falls into the
    // order by what it holds.
    const tenant = opts.authority.tenantId
      ? await this.prisma.tenant.findUnique({
          where: { id: opts.authority.tenantId },
          select: { ownerUserId: true, tenantType: true },
        })
      : null;
    const targetKeys = permissionsOf(target).filter((k) => !k.startsWith('self.'));
    if (
      holdsPermission(targetKeys, '*') ||
      authorityOver(
        { userId: admin.id, permissions: permissionsOf(admin), as: opts.authority.as },
        { userId: target.id, permissions: targetKeys },
        { ownerUserId: tenant?.ownerUserId ?? null, platform: tenant?.tenantType === TenantType.platform_owner },
      )
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
}
