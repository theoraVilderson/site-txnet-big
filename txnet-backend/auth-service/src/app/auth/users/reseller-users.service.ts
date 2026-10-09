import { Injectable } from '@nestjs/common';
import { Prisma, SessionRevokedReason, TenantType, UserStatus } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerActor,
  ResellerAccessRejection,
  SupportConsentRefused,
  SupportConsentRejection,
  TenantCapabilityName,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { maskPhone } from '../../common/validation/phone.schema';
import { SessionService } from '../session/session.service';
import { SurfaceOwnerService } from '../surface-owner/surface-owner.service';
import { AuthorityTenant, TARGET_PERMISSIONS_SELECT, authorityOver, permissionsOf } from './authority';
import { matchers } from './user-search.service';

/** Who is asking, as `AuthGuard` left them on the request. */
export type ResellerUsersActor = ResellerActor;

/** Both doors' refusals in one union, so the controller maps one error type (F-066-w5's shape). */
export type ResellerUsersRejection =
  | ResellerAccessRejection
  | SupportConsentRejection
  | 'user_not_found'
  | 'user_banned'
  | 'cannot_block_self'
  | 'no_authority'
  | 'username_taken';

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
  /** What the person is shown for their status (ADR-0133); null while `active`. */
  statusReason: string | null;
  createdAt: string;
  canAct: boolean;
  staff: boolean;
  /** The role they hold (F-1201-c, the Team page); changed at `PUT …/users/:userId/role`. */
  role: { id: string; name: string } | null;
};

/**
 * One person, for the admin's user page (AC-1-a): the row, plus whether they
 * have an email — masked, because staff may remove an address but never need
 * to read one, and the list's "never an email" holds here too.
 */
export type ResellerUserProfile = ResellerUserView & { emailMasked: string | null };

/** What `PATCH …/users/:userId` may change; `email` only ever to `null` (identity invariant 15). */
export type ResellerUserProfileEdit = { fullName?: string; username?: string; email?: null };

export type ResellerUserPage = {
  items: ResellerUserView[];
  total: number;
  page: number;
  pageSize: number;
};

export type ResellerUserListInput = { q?: string; page: number; pageSize: number; staff?: boolean };

const SELECT = {
  id: true,
  fullName: true,
  username: true,
  phoneNumber: true,
  status: true,
  statusReason: true,
  createdAt: true,
  role: { select: { id: true, name: true, ...TARGET_PERMISSIONS_SELECT.role.select } },
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof SELECT }>;

const PROFILE_SELECT = { ...SELECT, email: true } as const;

type ProfileRow = Prisma.UserGetPayload<{ select: typeof PROFILE_SELECT }>;

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
    private readonly owners: SurfaceOwnerService,
  ) {}

  /** One page of this reseller's users, newest first. `q` is F-018-ad's matcher, asked inside this scope. */
  list(actor: ResellerUsersActor, tenantId: string, input: ResellerUserListInput): Promise<ResellerUserPage> {
    return this.run(actor, tenantId, 'read', async (admitted) => {
      const ctx = { actor, admitted, tenant: await this.tenantOf(admitted.id) };
      const where: Prisma.UserWhereInput = { deletedAt: null };
      if (input.q) where.OR = matchers(input.q);
      // The team (F-1201-c): the same rule as `staff` on a row, less the owner,
      // who is in another tenant and never on this list.
      if (input.staff) where.role = { rolePermissions: { some: {} } };

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
   * Block one of this reseller's users: `suspended` — restricted to support,
   * with the reason it is shown (ADR-0133) — and every live session gone.
   *
   * The next sign-in is the restricted one (`AuthService`), so the status is
   * the decision and the revoke is what makes it immediate — a token minted a
   * minute ago would otherwise keep working until it expired.
   */
  block(actor: ResellerUsersActor, tenantId: string, userId: string, ip: string, reason?: string): Promise<ResellerUserView> {
    return this.setStatus(actor, tenantId, userId, ip, UserStatus.suspended, reason?.trim() || null);
  }

  /** Lift a block. Only a `suspended` account is lifted — `banned` is the platform's, not the reseller's. */
  unblock(actor: ResellerUsersActor, tenantId: string, userId: string, ip: string): Promise<ResellerUserView> {
    return this.setStatus(actor, tenantId, userId, ip, UserStatus.active, null);
  }

  private setStatus(
    actor: ResellerUsersActor,
    tenantId: string,
    userId: string,
    ip: string,
    status: Exclude<UserStatus, 'banned'>,
    reason: string | null,
  ): Promise<ResellerUserView> {
    return this.run(actor, tenantId, 'staffWrite', async (reseller) => {
      // Blocking yourself locks the reseller out of its own panel with a button.
      // Rule 1 of the authority rule, answered with this surface's older reason.
      if (userId === actor.userId) throw new ResellerUsersRefused('cannot_block_self', userId);
      const ctx = { actor, admitted: reseller, tenant: await this.tenantOf(reseller.id) };

      // tenantTransaction, not a bare $transaction: the scope refuses `User`
      // queries in a transaction that bound no tenant (F-095).
      const changed = await tenantTransaction(this.prisma, async (tx) => {
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

        const updated = await tx.user.update({
          where: { id: userId },
          data: { status, statusReason: reason, statusChangedAt: new Date() },
          select: SELECT,
        });
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
            reason,
          },
        });
        return updated;
      });

      if (!changed) return view(await this.mustRead(userId), ctx);
      // After the transaction: Redis is not transactional, and a marker dropped
      // for a write that then rolled back would sign out an account nobody blocked.
      // Both ways (ADR-0133 decision 5): the next sign-in is the restricted
      // one, or the whole one — no token outlives the change.
      await this.sessions.revokeAllSessionsForUser(userId, SessionRevokedReason.admin_ban);
      return view(changed, ctx);
    });
  }

  /** One of this reseller's users, as the admin's user page shows them (AC-1-a). */
  profile(actor: ResellerUsersActor, tenantId: string, userId: string): Promise<ResellerUserProfile> {
    return this.run(actor, tenantId, 'read', async (admitted) => {
      const ctx = { actor, admitted, tenant: await this.tenantOf(admitted.id) };
      const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: PROFILE_SELECT });
      if (!user) throw new ResellerUsersRefused('user_not_found', userId);
      return profileView(user, ctx);
    });
  }

  /**
   * Staff edit a person's name, username or email (AC-1-a). Admitted like a
   * block, and asked of the same authority rule about the one person named
   * (ADR-0103) — editing someone is acting on them. Only the fields that
   * actually change are written, and one audit row records each as it was
   * and as it became; a body that changes nothing writes nothing.
   *
   * The email is only ever removed, together with its proof
   * (`emailVerifiedAt`): a stored address is one its owner proved (identity
   * invariant 15), and an address typed by staff is not. No session is
   * revoked — nothing here changes what the person may do.
   */
  editProfile(
    actor: ResellerUsersActor,
    tenantId: string,
    userId: string,
    ip: string,
    edit: ResellerUserProfileEdit,
  ): Promise<ResellerUserProfile> {
    return this.run(actor, tenantId, 'staffWrite', async (reseller) => {
      const ctx = { actor, admitted: reseller, tenant: await this.tenantOf(reseller.id) };

      const row = await tenantTransaction(this.prisma, async (tx) => {
        const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: PROFILE_SELECT });
        if (!user) throw new ResellerUsersRefused('user_not_found', userId);
        if (!view(user, ctx).canAct) throw new ResellerUsersRefused('no_authority', userId);
        if (user.status === UserStatus.banned) throw new ResellerUsersRefused('user_banned', userId);

        const data: Prisma.UserUpdateInput = {};
        const before: Record<string, string | null> = {};
        const after: Record<string, string | null> = {};
        if (edit.fullName !== undefined && edit.fullName !== user.fullName) {
          data.fullName = edit.fullName;
          before.fullName = user.fullName;
          after.fullName = edit.fullName;
        }
        if (edit.username !== undefined && edit.username !== user.username) {
          // Invariant 16: on a reseller's door the owner's username signs in as
          // the owner, so a customer holding it would shadow them for good.
          // The same answer as a username taken inside the tenant.
          if (await this.owners.ownerHoldsUsername(ctx.tenant.ownerUserId, reseller.id, edit.username)) {
            throw new ResellerUsersRefused('username_taken', userId);
          }
          data.username = edit.username;
          before.username = user.username;
          after.username = edit.username;
        }
        if (edit.email === null && user.email !== null) {
          data.email = null;
          data.emailVerifiedAt = null;
          before.email = maskEmail(user.email);
          after.email = null;
        }
        if (Object.keys(after).length === 0) return user;

        const updated = await tx.user
          .update({ where: { id: userId }, data, select: PROFILE_SELECT })
          .catch((err: unknown) => {
            // `@@unique([tenantId, username])`: the write is the check, so two
            // staff renaming two people to one name cannot both win.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              throw new ResellerUsersRefused('username_taken', userId);
            }
            throw err;
          });
        await tx.adminAuditLog.create({
          data: {
            tenantId: reseller.id,
            adminId: actor.userId,
            action: 'user_profile_update',
            targetEntityType: 'user',
            targetEntityId: userId,
            oldValue: before,
            newValue: after,
            adminIpAddress: ip,
          },
        });
        return updated;
      });

      return profileView(row, ctx);
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
      if (err instanceof ResellerAccessRefused || err instanceof SupportConsentRefused) {
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
    statusReason: row.statusReason,
    createdAt: row.createdAt.toISOString(),
    canAct: refusal === null,
    staff: permissions.length > 0 || row.id === ctx.tenant.ownerUserId,
    role: row.role ? { id: row.role.id, name: row.role.name } : null,
  };
}

function profileView(row: ProfileRow, ctx: ViewContext): ResellerUserProfile {
  return { ...view(row, ctx), emailMasked: row.email ? maskEmail(row.email) : null };
}

/** `ali.rezaei@example.com` -> `a***@example.com`: enough to recognise, not to write to. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}
