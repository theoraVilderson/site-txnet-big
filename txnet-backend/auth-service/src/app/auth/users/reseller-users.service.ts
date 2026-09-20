import { Injectable } from '@nestjs/common';
import { Prisma, SessionRevokedReason, UserStatus } from '@prisma/client';
import {
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  TenantCapabilityName,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { maskPhone } from '../../common/validation/phone.schema';
import { SessionService } from '../session/session.service';
import { matchers } from './user-search.service';

/** Who is asking, as `AuthGuard` left them on the request. */
export type ResellerUsersActor = { userId: string; tenantId: string; permissions: string[] };

/** Both doors' refusals in one union, so the controller maps one error type (F-066-w5's shape). */
export type ResellerUsersRejection =
  | ResellerAccessRejection
  | 'user_not_found'
  | 'user_banned'
  | 'cannot_block_self';

export class ResellerUsersRefused extends Error {
  constructor(
    readonly reason: ResellerUsersRejection,
    detail = '',
  ) {
    super(`reseller users refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ResellerUsersRefused';
  }
}

/** One row of the list. Enough to recognise a customer; never the number, never an email. */
export type ResellerUserView = {
  id: string;
  fullName: string;
  username: string | null;
  phoneMasked: string | null;
  status: UserStatus;
  createdAt: string;
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
} as const;

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
    return this.run(actor, tenantId, 'read', async () => {
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

      return { items: rows.map(view), total, page: input.page, pageSize: input.pageSize };
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
      if (userId === actor.userId) throw new ResellerUsersRefused('cannot_block_self', userId);

      const changed = await this.prisma.$transaction(async (tx) => {
        // Inside the scope, so an id from another tenant is simply not found —
        // the same answer an id that never existed gets.
        const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: SELECT });
        if (!user) throw new ResellerUsersRefused('user_not_found', userId);
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

      if (!changed) return view(await this.mustRead(userId));
      // After the transaction: Redis is not transactional, and a marker dropped
      // for a write that then rolled back would sign out an account nobody blocked.
      if (status === UserStatus.suspended) {
        await this.sessions.revokeAllSessionsForUser(userId, SessionRevokedReason.admin_ban);
      }
      return view(changed);
    });
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
    work: (reseller: { id: string }) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, capability, (reseller) => work(reseller));
    } catch (err) {
      if (err instanceof ResellerAccessRefused) {
        throw new ResellerUsersRefused(err.reason, tenantId);
      }
      throw err;
    }
  }
}

function view(row: {
  id: string;
  fullName: string;
  username: string | null;
  phoneNumber: string | null;
  status: UserStatus;
  createdAt: Date;
}): ResellerUserView {
  return {
    id: row.id,
    fullName: row.fullName,
    username: row.username,
    phoneMasked: maskPhone(row.phoneNumber),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
