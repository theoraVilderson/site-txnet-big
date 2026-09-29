import { Injectable } from '@nestjs/common';
import { Prisma, SessionRevokedReason, TenantType, UserStatus } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  TenantCapabilityName,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { maskPhone } from '../../common/validation/phone.schema';
import { SessionService } from '../session/session.service';
import { AuthorityTenant, TARGET_PERMISSIONS_SELECT, authorityOver, permissionsOf } from './authority';
import { matchers } from './user-search.service';

/** Who is asking, as `AuthGuard` left them on the request. */
export type ResellerUsersActor = { userId: string; tenantId: string; permissions: string[] };

/** Both doors' refusals in one union, so the controller maps one error type (F-066-w5's shape). */
export type ResellerUsersRejection =
  | ResellerAccessRejection
  | 'user_not_found'
  | 'user_banned'
  | 'cannot_block_self'
  | 'no_authority';

export class ResellerUsersRefused extends Error {
  constructor(
    readonly reason: ResellerUsersRejection,
    detail = '',
  ) {
    super(`reseller users refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ResellerUsersRefused';
  }
}

/**
 * One row of the list. Enough to recognise a customer; never the number, never
 * an email. `canAct` is the answer the authority rule (ADR-0103) gives the
 * caller for this person, so the panel is told rather than left to guess;
 * `staff` marks a person who holds any permission, or owns the tenant.
 */
export type ResellerUserView = {
  id: string;
  fullName: string;
  username: string | null;
  phoneMasked: string | null;
  status: UserStatus;
  createdAt: string;
  canAct: boolean;
  staff: boolean;
};

export type ResellerUserPage = {
  items: ResellerUserView[];
  total: number;
  page: number;
  pageSize: number;
};

export type ResellerUserListInput = { q?: string; page: number; pageSize: number };

const SELECT = {
  id: true,
  fullName: true,
  username: true,
  phoneNumber: true,
  status: true,
  createdAt: true,
  ...TARGET_PERMISSIONS_SELECT,
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof SELECT }>;

/** What `view` needs to answer `canAct`: who asks, how they were admitted, and the tenant's owner. */
type ViewContext = { actor: ResellerUsersActor; admitted: AdmittedReseller; tenant: AuthorityTenant };

/**
 * A reseller's own users (F-311-a, spec F-311): read a page of them, and block
 * or unblock one. The data half of the bot's management panel (F-311-c), built
 * here once so a future panel page shares it — the way F-066-w3 serves F-066-w4.
 *
 * **Creation is deliberately absent.** A reseller's user is created by
 * registering on that reseller's domain (F-061-d); an admin-typed account would
 * be a second way for a person to exist in a tenant, with no verified phone
 * behind it.
 *
 * **The scope is the whole filter.** `ResellerAccess.run` opens the admitted
 * reseller's tenant, so the app pool's RLS already answers "whose users"; no
 * query here names a `tenantId`, because a filter written by hand is a filter
 * that can be written wrong, and the row this item exists to prevent is one
 * reseller reading another's customers.
 *
 * **`banned` outranks a block.** A reseller suspends and un-suspends; the
 * platform's own `banned` is neither set nor lifted from this surface, so a
 * reseller cannot restore an account the platform closed.
 */
@Injectable()
export class ResellerUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly sessions: SessionService,
  ) {}

  /** One page of this reseller's users, newest first. `q` is F-018-ad's matcher, asked inside this scope. */
  list(actor: ResellerUsersActor, tenantId: string, input: ResellerUserListInput): Promise<ResellerUserPage> {
    return this.run(actor, tenantId, 'read', async (admitted) => {
      const ctx = { actor, admitted, tenant: await this.tenantOf(admitted.id) };
      const where: Prisma.UserWhereInput = { deletedAt: null };
      if (input.q) where.OR = matchers(input.q);

      const [rows, total] = await Promise.all([
        this.prisma.user.findMany({
          where,
          select: SELECT,
          orderBy: { createdAt: 'desc' },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        this.prisma.user.count({ where }),
      ]);

      return { items: rows.map((row) => view(row, ctx)), total, page: input.page, pageSize: input.pageSize };
    });
  }

  /**
   * Block one of this reseller's users: `suspended`, every live session gone.
   *
   * Sign-in already refuses anything but `active` (`AuthService`), so the
   * status is the decision and the revoke is what makes it immediate — a token
   * minted a minute ago would otherwise keep working until it expired.
   */
  block(actor: ResellerUsersActor, tenantId: string, userId: string, ip: string): Promise<ResellerUserView> {
    return this.setStatus(actor, tenantId, userId, ip, UserStatus.suspended);
  }

  /** Lift a block. Only a `suspended` account is lifted — `banned` is the platform's, not the reseller's. */
  unblock(actor: ResellerUsersActor, tenantId: string, userId: string, ip: string): Promise<ResellerUserView> {
    return this.setStatus(actor, tenantId, userId, ip, UserStatus.active);
  }

  private setStatus(
    actor: ResellerUsersActor,
    tenantId: string,
    userId: string,
    ip: string,
    status: Exclude<UserStatus, 'banned'>,
  ): Promise<ResellerUserView> {
    return this.run(actor, tenantId, 'staffWrite', async (reseller) => {
      // Blocking yourself locks the reseller out of its own panel with a button.
      // Rule 1 of the authority rule, answered with this surface's older reason.
      if (userId === actor.userId) throw new ResellerUsersRefused('cannot_block_self', userId);
      const ctx = { actor, admitted: reseller, tenant: await this.tenantOf(reseller.id) };

      const changed = await this.prisma.$transaction(async (tx) => {
        // Inside the scope, so an id from another tenant is simply not found —
        // the same answer an id that never existed gets.
        const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: SELECT });
        if (!user) throw new ResellerUsersRefused('user_not_found', userId);
        // ADR-0103: the admission says who may administer this tenant; this says
        // whether they may act on this one person. The target's keys are read
        // here, at the act, from their role.
        if (!view(user, ctx).canAct) throw new ResellerUsersRefused('no_authority', userId);
        if (user.status === UserStatus.banned) throw new ResellerUsersRefused('user_banned', userId);
        // Idempotent: the second click of a button is not a second audit row.
        if (user.status === status) return null;

        const updated = await tx.user.update({ where: { id: userId }, data: { status }, select: SELECT });
        await tx.adminAuditLog.create({
          data: {
            // The reseller's own trail, not the platform's: this act was taken
            // inside that tenant and is read back with it.
            tenantId: reseller.id,
            adminId: actor.userId,
            action: status === UserStatus.suspended ? 'user_ban' : 'user_unban',
            targetEntityType: 'user',
            targetEntityId: userId,
            oldValue: { status: user.status },
            newValue: { status },
            adminIpAddress: ip,
          },
        });
        return updated;
      });

      if (!changed) return view(await this.mustRead(userId), ctx);
      // After the transaction: Redis is not transactional, and a marker dropped
      // for a write that then rolled back would sign out an account nobody blocked.
      if (status === UserStatus.suspended) {
        await this.sessions.revokeAllSessionsForUser(userId, SessionRevokedReason.admin_ban);
      }
      return view(changed, ctx);
    });
  }

  /** The tenant's owner and kind, on the app pool — `tenant.tenant` has no RLS. */
  private async tenantOf(id: string): Promise<AuthorityTenant> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { ownerUserId: true, tenantType: true },
    });
    return {
      ownerUserId: tenant?.ownerUserId ?? null,
      platform: tenant?.tenantType === TenantType.platform_owner,
    };
  }

  private async mustRead(userId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: SELECT });
    if (!user) throw new ResellerUsersRefused('user_not_found', userId);
    return user;
  }

  /** Admit, run in the reseller's scope, and translate the door's refusal into this surface's one type. */
  private async run<T>(
    actor: ResellerUsersActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (reseller: AdmittedReseller) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.access.runIncludingPlatform(actor, tenantId, capability, (reseller) => work(reseller));
    } catch (err) {
      if (err instanceof ResellerAccessRefused) {
        throw new ResellerUsersRefused(err.reason, tenantId);
      }
      throw err;
    }
  }
}

function view(row: UserRow, ctx: ViewContext): ResellerUserView {
  const permissions = permissionsOf(row);
  const refusal = authorityOver(
    { userId: ctx.actor.userId, permissions: ctx.actor.permissions, as: ctx.admitted.as },
    { userId: row.id, permissions },
    ctx.tenant,
  );
  return {
    id: row.id,
    fullName: row.fullName,
    username: row.username,
    phoneMasked: maskPhone(row.phoneNumber),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    canAct: refusal === null,
    staff: permissions.length > 0 || row.id === ctx.tenant.ownerUserId,
  };
}
