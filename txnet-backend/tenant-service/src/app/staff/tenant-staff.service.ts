import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, UserStatus } from '@prisma/client';
import {
  AccessHistoryCause,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  recordAccessChange,
  runWithTenant,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import type { InviteStaffInput } from './tenant-staff.schema';

/**
 * A reseller's own team (F-018-j, catalog F-1201, D-42 (2)).
 *
 * **Membership, not a role.** `tenant_staff_member` says who is on the team,
 * from when, until when, and whether they were removed. What a member may do is
 * their `identity.user.roleId` — a role of that tenant since F-018-n — which is
 * the role `forward-auth` already puts on their token. One RBAC: a second
 * ladder here would be a rank no request could read.
 *
 * **A seat is granted to someone who is already a user of the reseller.** They
 * signed up on the reseller's own panel; this service never writes
 * `identity.user`, as `ResellerService` does not for an owner. The reseller's
 * *owner* is deliberately not seatable: they are a user of the platform's
 * tenant (ADR-0059), and moving an account across tenants is the decision
 * ADR-0062 left open. Inviting a person who does not yet have an account is a
 * row of its own — it needs an email invitation and a registration, neither of
 * which this table would hold.
 *
 * **Who reaches it** is {@link ResellerAccess} (invariant 21): the path's
 * reseller, by its owner, by the platform owner's staff, or by a member of that
 * reseller holding `staff.manage` (AC-1-e) — the seat this service grants is what makes
 * the third door open. Reading the team is `read` and changing it is
 * `staffWrite`, so a suspended reseller sees its team and cannot change it.
 *
 * **The pool.** A reseller's `tenant_staff_member` and `identity.user` rows are
 * not the owner's tenant's, so the work runs on the cross-tenant pool, after
 * `ResellerAccess` has refused on the app pool (ADR-0053's order).
 */

/** `ip` is what a seat's audit row records (AC-1-p). */
export type StaffActor = ResellerActor & { ip?: string };

/** What a seat is, at a moment: the four states `list` reports. */
export type StaffState = 'invited' | 'active' | 'expired' | 'revoked';

export type StaffView = {
  id: string;
  userId: string;
  state: StaffState;
  invitedByUserId: string | null;
  invitedAt: Date;
  joinedAt: Date | null;
  accessExpiresAt: Date | null;
  revokedAt: Date | null;
  user: { id: string; fullName: string; username: string | null; phoneNumber: string | null } | null;
  /** Their role of this tenant (F-018-n) — where their permissions actually come from. */
  role: { id: string; name: string } | null;
};

export type StaffRejection =
  | ResellerAccessRejection
  | 'user_not_found'
  | 'user_inactive'
  | 'already_staff'
  | 'expiry_past'
  | 'staff_not_found'
  | 'no_invite';

export class StaffRefused extends Error {
  constructor(
    readonly reason: StaffRejection,
    detail = '',
  ) {
    super(`staff refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'StaffRefused';
  }
}

const USER_SELECT = {
  id: true,
  fullName: true,
  username: true,
  phoneNumber: true,
  status: true,
  role: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

type StaffRow = Prisma.TenantStaffMemberGetPayload<Record<string, never>>;

@Injectable()
export class TenantStaffService {
  private readonly logger = new Logger(TenantStaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly resellerAccess: ResellerAccess,
  ) {}

  async list(actor: StaffActor, tenantId: string, now = new Date()): Promise<StaffView[]> {
    const reseller = await this.admit(actor, tenantId, 'read', now);
    const rows = await this.all.tenantStaffMember.findMany({
      where: { tenantId: reseller.id },
      orderBy: { invitedAt: 'desc' },
    });
    return this.withUsers(rows, now);
  }

  async invite(actor: StaffActor, tenantId: string, input: InviteStaffInput, now = new Date()): Promise<StaffView> {
    const reseller = await this.admit(actor, tenantId, 'staffWrite', now);
    if (input.accessExpiresAt && input.accessExpiresAt <= now) throw new StaffRefused('expiry_past', input.accessExpiresAt.toISOString());

    // A seat is for a user of this reseller. The owner is in another tenant, so
    // they fall out here without a refusal of their own to leak the ownership.
    const person = await this.all.user.findFirst({
      where: { id: input.userId, tenantId: reseller.id, deletedAt: null },
      select: USER_SELECT,
    });
    if (!person) throw new StaffRefused('user_not_found', input.userId);
    if (person.status !== UserStatus.active) throw new StaffRefused('user_inactive', input.userId);

    const existing = await this.all.tenantStaffMember.findFirst({ where: { tenantId: reseller.id, userId: person.id } });
    if (existing && !existing.revokedAt) throw new StaffRefused('already_staff', input.userId);

    // A removed member is re-invited **in place**: `(tenantId, userId)` is
    // unique, so the alternative is not a second row but a lost history.
    const seat = await this.all.$transaction(async (tx) => {
      const row = existing
        ? await tx.tenantStaffMember.update({
            where: { id: existing.id },
            data: { invitedByUserId: actor.userId, invitedAt: now, joinedAt: null, accessExpiresAt: input.accessExpiresAt ?? null, revokedAt: null },
          })
        : await tx.tenantStaffMember.create({
            data: { tenantId: reseller.id, userId: person.id, invitedByUserId: actor.userId, invitedAt: now, accessExpiresAt: input.accessExpiresAt ?? null },
          });
      // AC-1-p: no access until accepted, so nobody is told — but the history keeps who invited.
      await this.audited(tx, actor, reseller.id, row, 'seat_invited', AdminAction.staff_seat_invite, existing ? seatValues(existing) : null, seatValues(row));
      return row;
    });
    this.logger.log(`staff seat ${seat.id} on ${reseller.slug} invited ${person.id} by ${actor.userId}`);
    return this.view(seat, person, now);
  }

  /**
   * The invitee accepts, themselves.
   *
   * Not a `ResellerAccess` route: a seat that has not been accepted is exactly
   * what does not admit anyone yet. The door is instead that the caller's own
   * session is in this reseller and names the invited user — which is why every
   * other case answers `no_invite` rather than saying whose seat it was.
   *
   * It is the one method on the **app** pool: the invitee's own tenant is the
   * reseller, so RLS binds the read to it and a mistake in the `where` cannot
   * reach another reseller's seats.
   */
  async accept(actor: StaffActor, tenantId: string, now = new Date()): Promise<StaffView> {
    if (actor.tenantId !== tenantId) throw new StaffRefused('no_invite', tenantId);
    const seat = await this.prisma.tenantStaffMember.findFirst({
      where: { tenantId, userId: actor.userId, joinedAt: null, revokedAt: null },
    });
    if (!seat) throw new StaffRefused('no_invite', tenantId);
    if (seat.accessExpiresAt && seat.accessExpiresAt <= now) throw new StaffRefused('no_invite', tenantId);

    // Bound to the path's tenant, which is the caller's own (checked above).
    const joined = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const row = await tx.tenantStaffMember.update({ where: { id: seat.id }, data: { joinedAt: now } });
        // AC-1-p: the person's own act, so no audit row; their own panel refreshes on the answer.
        await recordAccessChange(tx, [{ userId: actor.userId, tenantId, cause: 'seat_joined', actorUserId: actor.userId, auditLogId: null }]);
        return row;
      }),
    );
    this.logger.log(`staff seat ${seat.id} accepted by ${actor.userId}`);
    return (await this.withUsers([joined], now))[0];
  }

  /**
   * A seat's end moved or cleared, without re-inviting (F-1201-b): the row,
   * its acceptance and its history stay. An expired seat given a later end (or
   * none) is a seat again, and the member is told their access is back (AC-1-q).
   * A seat is not counted against `staff_members_max` — it admits nobody since
   * GR-1-a; the limit counts who holds a reseller key through a group (GR-1-b). Moving
   * the end of a seat that still admits them changes nothing they can see now.
   */
  async setExpiry(actor: StaffActor, tenantId: string, memberId: string, accessExpiresAt: Date | null, now = new Date()): Promise<StaffView> {
    const reseller = await this.admit(actor, tenantId, 'staffWrite', now);
    if (accessExpiresAt && accessExpiresAt <= now) throw new StaffRefused('expiry_past', accessExpiresAt.toISOString());
    const seat = await this.all.tenantStaffMember.findFirst({ where: { id: memberId, tenantId: reseller.id, revokedAt: null } });
    if (!seat) throw new StaffRefused('staff_not_found', memberId);

    const restored = staffState(seat, now) === 'expired';
    const updated = await this.all.$transaction(async (tx) => {
      const row = await tx.tenantStaffMember.update({ where: { id: seat.id }, data: { accessExpiresAt } });
      // A seat brought back is told (AC-1-q); an end moved is only remembered (AC-1-p).
      const cause = restored && row.joinedAt ? 'seat_restored' : 'seat_end_set';
      await this.audited(tx, actor, reseller.id, row, cause, AdminAction.staff_seat_end_set, seatValues(seat), seatValues(row));
      return row;
    });
    this.logger.log(`staff seat ${seat.id} on ${reseller.slug} now ends ${accessExpiresAt?.toISOString() ?? 'never'}, by ${actor.userId}`);
    return (await this.withUsers([updated], now))[0];
  }

  /** Removal keeps the row: who was on this team last month is a question an audit asks. */
  async remove(actor: StaffActor, tenantId: string, memberId: string, now = new Date()): Promise<StaffView> {
    const reseller = await this.admit(actor, tenantId, 'staffWrite', now);
    const seat = await this.all.tenantStaffMember.findFirst({ where: { id: memberId, tenantId: reseller.id, revokedAt: null } });
    if (!seat) throw new StaffRefused('staff_not_found', memberId);

    const revoked = await this.all.$transaction(async (tx) => {
      const row = await tx.tenantStaffMember.update({ where: { id: seat.id }, data: { revokedAt: now } });
      // AC-1-q: the member's panel loses this reseller now, not on the next refused call.
      await this.audited(tx, actor, reseller.id, row, 'seat_removed', AdminAction.staff_seat_remove, seatValues(seat), seatValues(row));
      return row;
    });
    this.logger.log(`staff seat ${seat.id} on ${reseller.slug} removed by ${actor.userId}`);
    return (await this.withUsers([revoked], now))[0];
  }

  /** A seat act's audit row, and the seat holder's history row (and notice, for a told cause) against it (AC-1-p). */
  private async audited(
    tx: Prisma.TransactionClient,
    actor: StaffActor,
    tenantId: string,
    seat: { id: string; userId: string },
    cause: AccessHistoryCause,
    action: AdminAction,
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    const act = await tx.adminAuditLog.create({
      data: {
        tenantId,
        adminId: actor.userId,
        action,
        targetEntityType: AuditTargetType.staff_seat,
        targetEntityId: seat.id,
        oldValue: before ?? Prisma.DbNull,
        newValue: after,
        adminIpAddress: actor.ip ?? '0.0.0.0',
      },
      select: { id: true },
    });
    await recordAccessChange(tx, [{ userId: seat.userId, tenantId, cause, actorUserId: actor.userId, auditLogId: act.id }]);
  }

  private async admit(actor: StaffActor, tenantId: string, capability: 'read' | 'staffWrite', now: Date) {
    try {
      return await this.resellerAccess.for('staff.manage').admit(actor, tenantId, capability, now);
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new StaffRefused(e.reason, tenantId);
      throw e;
    }
  }

  private async withUsers(rows: StaffRow[], now: Date): Promise<StaffView[]> {
    const people = await this.all.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: USER_SELECT });
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((row) => this.view(row, byId.get(row.userId) ?? null, now));
  }

  private view(row: StaffRow, person: UserRow | null, now: Date): StaffView {
    return {
      id: row.id,
      userId: row.userId,
      state: staffState(row, now),
      invitedByUserId: row.invitedByUserId,
      invitedAt: row.invitedAt,
      joinedAt: row.joinedAt,
      accessExpiresAt: row.accessExpiresAt,
      revokedAt: row.revokedAt,
      user: person ? { id: person.id, fullName: person.fullName, username: person.username, phoneNumber: person.phoneNumber } : null,
      role: person?.role ? { id: person.role.id, name: person.role.name } : null,
    };
  }
}

/**
 * The one reading of a seat, used by the view and by {@link ResellerAccess}:
 * only `active` admits anyone. Order matters — a removed seat is `revoked`
 * whatever its dates say.
 */
export function staffState(
  row: { joinedAt: Date | null; accessExpiresAt: Date | null; revokedAt: Date | null },
  now: Date,
): StaffState {
  if (row.revokedAt) return 'revoked';
  if (row.accessExpiresAt && row.accessExpiresAt <= now) return 'expired';
  return row.joinedAt ? 'active' : 'invited';
}

/** What a seat's audit row records: whose it is and when it ends (AC-1-p). */
function seatValues(seat: { userId: string; accessExpiresAt: Date | null; revokedAt: Date | null }): Prisma.InputJsonValue {
  return { userId: seat.userId, accessExpiresAt: seat.accessExpiresAt?.toISOString() ?? null, revokedAt: seat.revokedAt?.toISOString() ?? null };
}
