import { Injectable } from '@nestjs/common';
import { AdminAction } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  ResellerKey,
  SupportConsentRefused,
  SupportConsentRejection,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

export type AccessHistoryRejection = ResellerAccessRejection | SupportConsentRejection | 'user_not_found';

export class AccessHistoryRefused extends Error {
  constructor(
    readonly reason: AccessHistoryRejection,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/**
 * Every act that moves what someone may do (AC-1-p): the tenant's log lists
 * these and nothing else. A role set on a person, a key given, taken or lifted,
 * a group's access and its members, a role's keys, a staff seat.
 */
export const ACCESS_ACTIONS = [
  AdminAction.role_change,
  AdminAction.user_permission_set,
  AdminAction.user_permission_lift,
  AdminAction.user_group_access_set,
  AdminAction.user_group_member_add,
  AdminAction.user_group_member_remove,
  AdminAction.user_group_delete,
  AdminAction.role_keys_set,
  AdminAction.staff_seat_invite,
  AdminAction.staff_seat_end_set,
  AdminAction.staff_seat_remove,
] as const;

/** A page of either list. */
const PAGE = 50;

type Named = { id: string; name: string | null };
type Values = Record<string, unknown> | null;

/** One act as both lists show it: who did what to which, before, after, why. */
export type AccessAct = {
  id: string;
  at: string;
  action: AdminAction;
  actor: Named;
  target: { type: string; id: string; name: string | null };
  before: Values;
  after: Values;
  reason: string | null;
};

/** One row of a person's history: what their answer gained and lost, and the act that did it. */
export type AccessHistoryItem = {
  id: string;
  at: string;
  cause: string;
  given: string[];
  taken: string[];
  actor: Named;
  /** Null for the person's own act (a seat accepted), which has no audit row. */
  act: Omit<AccessAct, 'id' | 'at' | 'actor'> | null;
};

export type AccessHistoryPage<T> = { page: number; items: T[]; more: boolean };

type ActRow = {
  id: string;
  adminId: string;
  action: AdminAction;
  targetEntityType: string;
  targetEntityId: string;
  oldValue: Prisma.JsonValue;
  newValue: Prisma.JsonValue;
  reason: string | null;
  createdAt: Date;
};

/**
 * Who gave whom what, answered without the database (AC-1-p, audit
 * `contract.md` "Access history"). Two reads on a reseller's path:
 *
 * - a person's history — `access_history` rows (one per person an act moved,
 *   `recordAccessChange`) joined to the act's `admin_audit_log` row; door
 *   `role.manage` (who sees their keys) or `audit.read`;
 * - the tenant's log — the acts themselves, each with how many people it
 *   moved; door `audit.read`.
 *
 * Names: users across tenants (a reseller's owner and the platform's staff are
 * users of the platform's tenant, ADR-0059) — the name only; groups and roles
 * in the tenant's scope.
 */
@Injectable()
export class AccessHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly access: ResellerAccess,
  ) {}

  ofPerson(actor: ResellerActor, tenantId: string, userId: string, page: number): Promise<AccessHistoryPage<AccessHistoryItem>> {
    return this.run(['role.manage', 'audit.read'], actor, tenantId, (admitted) =>
      tenantTransaction(this.prisma, async (tx) => {
        const person = await tx.user.findFirst({ where: { id: userId, tenantId: admitted.id }, select: { id: true } });
        if (!person) throw new AccessHistoryRefused('user_not_found', userId);
        const rows = await tx.accessHistory.findMany({
          where: { tenantId: admitted.id, userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * PAGE,
          take: PAGE + 1,
        });
        const shown = rows.slice(0, PAGE);
        const ids = shown.flatMap((r) => (r.auditLogId ? [r.auditLogId] : []));
        const acts = ids.length > 0 ? ((await tx.adminAuditLog.findMany({ where: { id: { in: ids } } })) as ActRow[]) : [];
        const names = await this.names(tx, acts, shown.map((r) => r.actorUserId));
        const byId = new Map(acts.map((a) => [a.id, this.act(a, names)]));
        const items = shown.map((r): AccessHistoryItem => {
          const act = r.auditLogId ? byId.get(r.auditLogId) : undefined;
          return {
            id: r.id,
            at: r.createdAt.toISOString(),
            cause: r.cause,
            given: r.given,
            taken: r.taken,
            actor: { id: r.actorUserId, name: names.users.get(r.actorUserId) ?? null },
            act: act ? { action: act.action, target: act.target, before: act.before, after: act.after, reason: act.reason } : null,
          };
        });
        return { page, items, more: rows.length > PAGE };
      }),
    );
  }

  ofTenant(actor: ResellerActor, tenantId: string, page: number): Promise<AccessHistoryPage<AccessAct & { moved: number }>> {
    return this.run(['audit.read'], actor, tenantId, (admitted) =>
      tenantTransaction(this.prisma, async (tx) => {
        const rows = (await tx.adminAuditLog.findMany({
          where: { tenantId: admitted.id, action: { in: [...ACCESS_ACTIONS] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * PAGE,
          take: PAGE + 1,
        })) as ActRow[];
        const shown = rows.slice(0, PAGE);
        const counts =
          shown.length > 0
            ? await tx.accessHistory.groupBy({ by: ['auditLogId'], where: { auditLogId: { in: shown.map((r) => r.id) } }, _count: { _all: true } })
            : [];
        const moved = new Map(counts.map((c) => [c.auditLogId, c._count._all]));
        const names = await this.names(tx, shown, []);
        return { page, items: shown.map((a) => ({ ...this.act(a, names), moved: moved.get(a.id) ?? 0 })), more: rows.length > PAGE };
      }),
    );
  }

  private act(a: ActRow, names: Names): AccessAct {
    const before = withRoleName(values(a.oldValue), names.roles);
    const after = withRoleName(values(a.newValue), names.roles);
    return {
      id: a.id,
      at: a.createdAt.toISOString(),
      action: a.action,
      actor: { id: a.adminId, name: names.users.get(a.adminId) ?? null },
      target: { type: a.targetEntityType, id: a.targetEntityId, name: targetName(a, names) },
      before,
      after,
      // A key's reason was written in its values before AC-1-p gave it the column.
      reason: a.reason ?? stringOf(after?.['reason']) ?? stringOf(before?.['reason']),
    };
  }

  /** Every name the rows mention, three reads at most. */
  private async names(tx: Prisma.TransactionClient, acts: readonly ActRow[], userIds: readonly string[]): Promise<Names> {
    const users = new Set(userIds);
    const groups = new Set<string>();
    const roles = new Set<string>();
    for (const a of acts) {
      users.add(a.adminId);
      if (a.targetEntityType === 'user') users.add(a.targetEntityId);
      if (a.targetEntityType === 'user_group') groups.add(a.targetEntityId);
      if (a.targetEntityType === 'role') roles.add(a.targetEntityId);
      for (const v of [values(a.oldValue), values(a.newValue)]) {
        const seatHolder = stringOf(v?.['userId']);
        if (seatHolder) users.add(seatHolder);
        const roleId = stringOf(v?.['roleId']);
        if (roleId) roles.add(roleId);
      }
    }
    const [u, g, r] = await Promise.all([
      users.size > 0 ? this.all.user.findMany({ where: { id: { in: [...users] } }, select: { id: true, fullName: true, username: true } }) : [],
      groups.size > 0 ? tx.userGroup.findMany({ where: { id: { in: [...groups] } }, select: { id: true, name: true } }) : [],
      roles.size > 0 ? tx.role.findMany({ where: { id: { in: [...roles] } }, select: { id: true, name: true } }) : [],
    ]);
    return {
      users: new Map(u.map((x): [string, string | null] => [x.id, x.fullName || x.username || null])),
      groups: new Map(g.map((x): [string, string] => [x.id, x.name])),
      roles: new Map(r.map((x): [string, string] => [x.id, x.name])),
    };
  }

  /** Admit by any one of `keys`, run in the tenant's scope, and translate the door's refusal. */
  private async run<T>(keys: ResellerKey[], actor: ResellerActor, tenantId: string, work: (admitted: AdmittedReseller) => Promise<T>): Promise<T> {
    try {
      return await this.access.for(...keys).runIncludingPlatform(actor, tenantId, 'read', work);
    } catch (err) {
      if (err instanceof ResellerAccessRefused || err instanceof SupportConsentRefused) {
        throw new AccessHistoryRefused(err.reason, tenantId);
      }
      throw err;
    }
  }
}

type Names = { users: Map<string, string | null>; groups: Map<string, string>; roles: Map<string, string> };

function values(v: Prisma.JsonValue): Values {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringOf(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A group's access names its role by id; the list shows it by name, as a role change already does. */
function withRoleName(v: Values, roles: Map<string, string>): Values {
  const roleId = stringOf(v?.['roleId']);
  if (!v || !roleId || 'roleName' in v) return v;
  return { ...v, roleName: roles.get(roleId) ?? null };
}

function targetName(a: ActRow, names: Names): string | null {
  switch (a.targetEntityType) {
    case 'user':
      return names.users.get(a.targetEntityId) ?? null;
    case 'user_group':
      // A deleted group is gone; its delete row keeps the name.
      return names.groups.get(a.targetEntityId) ?? stringOf(values(a.oldValue)?.['name']) ?? null;
    case 'role':
      return names.roles.get(a.targetEntityId) ?? null;
    case 'staff_seat': {
      const holder = stringOf(values(a.newValue)?.['userId']) ?? stringOf(values(a.oldValue)?.['userId']);
      return holder ? (names.users.get(holder) ?? null) : null;
    }
    default:
      return null;
  }
}
