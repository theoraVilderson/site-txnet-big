import { Injectable } from '@nestjs/common';
import { AdminAction, AuditTargetType, SessionRevokedReason, TenantType, UserStatus } from '@prisma/client';
import { holdsPermission, tenantTransaction } from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../session/session.service';
import { TenantContext } from '../../tenant-context/tenant-context';
import { TARGET_PERMISSIONS_SELECT, authorityOver, permissionsOf } from './authority';

/** Restrict to support, and lift a restriction (ADR-0133 decision 6). */
export const RESTRICTION_ASSIGN = 'restriction.assign';
/** Ban, and lift a ban — closes the way back, so a key of its own. */
export const USER_BAN = 'user.ban';

export type UserStatusRefusal =
  | 'wrong_tenant'
  | 'user_not_found'
  | 'no_permission'
  | 'reason_required'
  | 'self'
  | 'owner'
  | 'not_above';

export class UserStatusRefused extends Error {
  constructor(
    readonly reason: UserStatusRefusal,
    readonly subject?: string,
  ) {
    super(`user status refused: ${reason}${subject ? ` (${subject})` : ''}`);
  }
}

export type UserStatusActor = { userId: string; tenantId: string; permissions: readonly string[] };
export type UserStatusInput = { status: UserStatus; reason?: string };
export type UserStatusView = { id: string; status: UserStatus; statusReason: string | null };

/**
 * Staff set a person's status (BAN-1-d, ADR-0133): `active`, `suspended`
 * (restricted to support) or `banned`, with the reason the person is shown.
 *
 * In the gate's tenant only — the caller's own (RLS does the rest). Asked of
 * ADR-0103's authority rule, over the *staff* keys of the target: a
 * customer's `self.*` keys say what they may do to their own account, not
 * over anyone, and counting them would leave every customer above a support
 * agent who does not hold them.
 */
@Injectable()
export class UserStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  /** Where the person stands — for a screen about to offer a change. Either key reads it. */
  async read(actor: UserStatusActor, userId: string): Promise<UserStatusView> {
    const tenant = TenantContext.current('user status');
    if (actor.tenantId !== tenant.id) throw new UserStatusRefused('wrong_tenant', tenant.id);
    if (![RESTRICTION_ASSIGN, USER_BAN].some((k) => holdsPermission(actor.permissions, k))) {
      throw new UserStatusRefused('no_permission', RESTRICTION_ASSIGN);
    }
    const user = await tenantTransaction(this.prisma, (tx) =>
      tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, status: true, statusReason: true } }),
    );
    if (!user) throw new UserStatusRefused('user_not_found', userId);
    return user;
  }

  async set(actor: UserStatusActor, userId: string, input: UserStatusInput, ip: string): Promise<UserStatusView> {
    const tenant = TenantContext.current('user status');
    if (actor.tenantId !== tenant.id) throw new UserStatusRefused('wrong_tenant', tenant.id);
    const reason = input.status === UserStatus.active ? null : input.reason?.trim() || null;
    if (input.status !== UserStatus.active && !reason) throw new UserStatusRefused('reason_required', userId);
    // Tried before a row is read: a refused caller learns nothing about who exists.
    if (userId === actor.userId) throw new UserStatusRefused('self', userId);

    const owner = await this.prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { ownerUserId: true, tenantType: true },
    });

    const change = await tenantTransaction(this.prisma, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true, status: true, statusReason: true, ...TARGET_PERMISSIONS_SELECT },
      });
      if (!user) throw new UserStatusRefused('user_not_found', userId);

      // A ban on either side of the change needs `user.ban`; everything else
      // about a restriction needs `restriction.assign`.
      const key = user.status === UserStatus.banned || input.status === UserStatus.banned ? USER_BAN : RESTRICTION_ASSIGN;
      if (!holdsPermission(actor.permissions, key)) throw new UserStatusRefused('no_permission', key);

      const refused = authorityOver(
        { userId: actor.userId, permissions: actor.permissions, as: 'member' },
        { userId: user.id, permissions: permissionsOf(user).filter((k) => !k.startsWith('self.')) },
        { ownerUserId: owner?.ownerUserId ?? null, platform: owner?.tenantType === TenantType.platform_owner },
      );
      if (refused) throw new UserStatusRefused(refused, userId);

      if (user.status === input.status && user.statusReason === reason) return { user, changed: false };

      const updated = await tx.user.update({
        where: { id: userId },
        data: { status: input.status, statusReason: reason, statusChangedAt: new Date() },
        select: { id: true, status: true, statusReason: true },
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: tenant.id,
          adminId: actor.userId,
          action: input.status === UserStatus.active ? AdminAction.user_unban : AdminAction.user_ban,
          targetEntityType: AuditTargetType.user,
          targetEntityId: userId,
          oldValue: { status: user.status, reason: user.statusReason },
          newValue: { status: input.status, reason },
          adminIpAddress: ip,
          reason,
        },
      });
      return { user: updated, changed: user.status !== input.status };
    });

    // After the commit: a marker dropped for a write that rolled back would
    // sign out a person nobody blocked. Every status change revokes — the next
    // sign-in is the restricted, the banned or the whole one (decision 5).
    if (change.changed) await this.sessions.revokeAllSessionsForUser(userId, SessionRevokedReason.admin_ban);
    return { id: change.user.id, status: change.user.status, statusReason: change.user.statusReason };
  }
}
