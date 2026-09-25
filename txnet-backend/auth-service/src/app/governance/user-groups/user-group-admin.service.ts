import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TenantType, UserGroupKind, UserGroupMemberType } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MemberCandidate, UserGroupRejection, groupRefusal, memberRefusal } from './user-group';

/**
 * Managing user groups (F-114-j, governance): `/api/auth/user-groups`.
 *
 * **Every query runs in the caller's own `tenantTransaction`**, so RLS is the
 * boundary: a group, and every member row of it, is the caller's tenant's —
 * the platform owner's included, whose groups are its own tenant's rows. What
 * the platform owner alone may do is *name* past its tenant (another tenant's
 * user, a reseller, every reseller): only for it, and only after
 * {@link isPlatform} says so, are the candidates looked up on the cross-tenant
 * pool. The permission is not the boundary — a reseller administers its own
 * roles and could grant itself `user_group.manage` (audit invariant #9) — and
 * `governance.user_group_scope_ok()` refuses the same in the database.
 *
 * A group a discount rule names is not deleted (`discount_rule`'s foreign key
 * is RESTRICT): the rule is changed first.
 */

export class UserGroupRefused extends Error {
  constructor(
    readonly reason: UserGroupRejection,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'UserGroupRefused';
  }
}

export type UserGroupActor = { adminId: string; tenantId: string; ip: string };

export type UserGroupInput = { name: string; allTenants?: boolean };
export type UserGroupPatch = Partial<UserGroupInput>;
export type UserGroupMembersInput = { userIds?: string[]; tenantIds?: string[] };

export type UserGroupView = {
  id: string;
  name: string;
  kind: UserGroupKind;
  allTenants: boolean;
  userCount: number;
  tenantCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** One member. `label` is a user's name or a reseller's slug — enough to recognise, never a phone. */
export type UserGroupMemberView = {
  memberType: UserGroupMemberType;
  userId: string | null;
  tenantId: string | null;
  label: string | null;
  addedAt: Date;
};

export type UserGroupMemberPage = { items: UserGroupMemberView[]; total: number; page: number; pageSize: number };

type Tx = Prisma.TransactionClient;
type GroupRow = { id: string; name: string; kind: UserGroupKind; allTenants: boolean; createdAt: Date; updatedAt: Date };
type Counts = { userCount: number; tenantCount: number };

function viewOf(g: GroupRow, c: Counts): UserGroupView {
  return { id: g.id, name: g.name, kind: g.kind, allTenants: g.allTenants, ...c, createdAt: g.createdAt, updatedAt: g.updatedAt };
}

const snapshot = (g: { name: string; allTenants: boolean }) => ({ name: g.name, allTenants: g.allTenants });

function isKnown(e: unknown, code: string): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;
}

@Injectable()
export class UserGroupAdminService {
  private readonly logger = new Logger(UserGroupAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** The platform owner's lookups past its own tenant. See the class comment. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  list(_actor: UserGroupActor): Promise<UserGroupView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const groups = await tx.userGroup.findMany({ orderBy: { name: 'asc' } });
      const counts = await this.countsOf(tx, groups.map((g) => g.id));
      return groups.map((g) => viewOf(g, counts.get(g.id) ?? { userCount: 0, tenantCount: 0 }));
    });
  }

  create(actor: UserGroupActor, input: UserGroupInput): Promise<UserGroupView> {
    const tenant = TenantContext.current('user group create');
    return this.writing(() =>
      tenantTransaction(this.prisma, async (tx) => {
        const allTenants = input.allTenants ?? false;
        const refused = groupRefusal(await this.isPlatform(tx, tenant.id), { allTenants });
        if (refused) throw new UserGroupRefused(refused);
        if (await tx.userGroup.findFirst({ where: { name: input.name }, select: { id: true } })) throw new UserGroupRefused('name_taken', input.name);

        const row = await tx.userGroup.create({ data: { tenantId: tenant.id, name: input.name, allTenants, createdByAdminId: actor.adminId } });
        await this.audit(tx, actor, tenant.id, 'user_group_create', row.id, null, snapshot(row));
        this.logger.log(`user group ${row.id} created by ${actor.adminId}`);
        return viewOf(row, { userCount: 0, tenantCount: 0 });
      }),
    );
  }

  update(actor: UserGroupActor, id: string, patch: UserGroupPatch): Promise<UserGroupView> {
    const tenant = TenantContext.current('user group update');
    return this.writing(() =>
      tenantTransaction(this.prisma, async (tx) => {
        const row = await this.mustFind(tx, id);
        const next = { name: patch.name ?? row.name, allTenants: patch.allTenants ?? row.allTenants };
        const refused = groupRefusal(await this.isPlatform(tx, tenant.id), next);
        if (refused) throw new UserGroupRefused(refused);
        if (next.name !== row.name && (await tx.userGroup.findFirst({ where: { name: next.name }, select: { id: true } }))) {
          throw new UserGroupRefused('name_taken', next.name);
        }
        // Every reseller, and some named: two answers to one question.
        if (next.allTenants && !row.allTenants && (await tx.userGroupMember.count({ where: { groupId: id, memberType: UserGroupMemberType.tenant } })) > 0) {
          throw new UserGroupRefused('all_tenants_conflict', id);
        }

        const updated = await tx.userGroup.update({ where: { id }, data: next });
        await this.audit(tx, actor, tenant.id, 'user_group_update', id, snapshot(row), snapshot(updated));
        return viewOf(updated, (await this.countsOf(tx, [id])).get(id) ?? { userCount: 0, tenantCount: 0 });
      }),
    );
  }

  /** Delete a group and its member rows. Refused while a discount rule names it. */
  async remove(actor: UserGroupActor, id: string): Promise<{ id: string; deleted: true }> {
    const tenant = TenantContext.current('user group delete');
    try {
      return await this.writing(() =>
        tenantTransaction(this.prisma, async (tx) => {
          const row = await this.mustFind(tx, id);
          await tx.userGroup.delete({ where: { id } });
          await this.audit(tx, actor, tenant.id, 'user_group_delete', id, snapshot(row), null);
          return { id, deleted: true as const };
        }),
      );
    } catch (e) {
      if (isKnown(e, 'P2003')) throw new UserGroupRefused('group_in_use', id);
      throw e;
    }
  }

  /** One page of a group's members, newest first. */
  members(_actor: UserGroupActor, id: string, page: number, pageSize: number): Promise<UserGroupMemberPage> {
    const tenant = TenantContext.current('user group members');
    return tenantTransaction(this.prisma, async (tx) => {
      await this.mustFind(tx, id);
      const where = { groupId: id };
      const [rows, total] = await Promise.all([
        tx.userGroupMember.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
        tx.userGroupMember.count({ where }),
      ]);

      // Another tenant's user or a reseller is only ever in the platform's group,
      // so only the platform reads names past its own tenant.
      const users = this.userReader(tx, await this.isPlatform(tx, tenant.id));
      const userIds = rows.flatMap((r) => (r.userId ? [r.userId] : []));
      const tenantIds = rows.flatMap((r) => (r.memberTenantId ? [r.memberTenantId] : []));
      const names = new Map<string, string>();
      if (userIds.length > 0) for (const u of await users.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })) names.set(u.id, u.fullName);
      if (tenantIds.length > 0) for (const t of await this.all.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, slug: true } })) names.set(t.id, t.slug);

      const items = rows.map((r) => ({
        memberType: r.memberType,
        userId: r.userId,
        tenantId: r.memberTenantId,
        label: names.get((r.userId ?? r.memberTenantId) as string) ?? null,
        addedAt: r.createdAt,
      }));
      return { items, total, page, pageSize };
    });
  }

  /** Add users and/or resellers. Idempotent: one already in is not added twice, and `added` counts only the new. */
  addMembers(actor: UserGroupActor, id: string, input: UserGroupMembersInput): Promise<{ added: number }> {
    const tenant = TenantContext.current('user group member add');
    const userIds = [...new Set(input.userIds ?? [])];
    const tenantIds = [...new Set(input.tenantIds ?? [])];
    return tenantTransaction(this.prisma, async (tx) => {
      const row = await this.mustFind(tx, id);
      const platform = await this.isPlatform(tx, tenant.id);
      const group = { tenantId: tenant.id, platform, allTenants: row.allTenants };

      const candidates: Array<[string, MemberCandidate]> = [];
      if (userIds.length > 0) {
        const found = await this.userReader(tx, platform).findMany({ where: { id: { in: userIds }, deletedAt: null }, select: { id: true, tenantId: true } });
        for (const userId of userIds) candidates.push([userId, { type: 'user', userTenantId: found.find((u) => u.id === userId)?.tenantId ?? null }]);
      }
      if (tenantIds.length > 0) {
        // A reseller cannot name one at all; asking the cross-tenant pool first would be the leak.
        const found = platform ? await this.all.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true } }) : [];
        for (const tenantId of tenantIds) candidates.push([tenantId, { type: 'tenant', tenantId, exists: found.some((t) => t.id === tenantId) }]);
      }
      for (const [memberId, c] of candidates) {
        const refused = memberRefusal(group, c);
        if (refused) throw new UserGroupRefused(refused, memberId);
      }

      const base = { groupId: id, tenantId: tenant.id, addedByAdminId: actor.adminId };
      const { count } = await tx.userGroupMember.createMany({
        data: [
          ...userIds.map((userId) => ({ ...base, memberType: UserGroupMemberType.user, userId })),
          ...tenantIds.map((memberTenantId) => ({ ...base, memberType: UserGroupMemberType.tenant, memberTenantId })),
        ],
        skipDuplicates: true,
      });
      if (count > 0) await this.audit(tx, actor, tenant.id, 'user_group_member_add', id, null, { userIds, tenantIds });
      return { added: count };
    });
  }

  removeMember(actor: UserGroupActor, id: string, member: { userId: string } | { tenantId: string }): Promise<{ removed: true }> {
    const tenant = TenantContext.current('user group member remove');
    return tenantTransaction(this.prisma, async (tx) => {
      await this.mustFind(tx, id);
      const where = 'userId' in member ? { groupId: id, userId: member.userId } : { groupId: id, memberTenantId: member.tenantId };
      const { count } = await tx.userGroupMember.deleteMany({ where });
      if (count === 0) throw new UserGroupRefused('member_not_found', 'userId' in member ? member.userId : member.tenantId);
      await this.audit(tx, actor, tenant.id, 'user_group_member_remove', id, where, null);
      return { removed: true as const };
    });
  }

  /** Whether the caller's tenant is the platform owner. `tenant.tenant` has no RLS policy (as `panelScopeOf`). */
  private async isPlatform(tx: Tx, tenantId: string): Promise<boolean> {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    return t?.tenantType === TenantType.platform_owner;
  }

  /** Users as this caller may see them: every tenant's for the platform owner, its own for anyone else. */
  private userReader(tx: Tx, platform: boolean): Pick<Tx['user'], 'findMany'> {
    return platform ? this.all.user : tx.user;
  }

  /** Inside the scope, so another tenant's group is simply not found. */
  private async mustFind(tx: Tx, id: string): Promise<GroupRow> {
    const row = await tx.userGroup.findUnique({ where: { id } });
    if (!row) throw new UserGroupRefused('group_not_found', id);
    return row;
  }

  private async countsOf(tx: Tx, ids: string[]): Promise<Map<string, Counts>> {
    const out = new Map<string, Counts>();
    if (ids.length === 0) return out;
    const rows = await tx.userGroupMember.groupBy({ by: ['groupId', 'memberType'], where: { groupId: { in: ids } }, _count: { _all: true } });
    for (const r of rows) {
      const c = out.get(r.groupId) ?? { userCount: 0, tenantCount: 0 };
      if (r.memberType === UserGroupMemberType.user) c.userCount = r._count._all;
      else c.tenantCount = r._count._all;
      out.set(r.groupId, c);
    }
    return out;
  }

  /** A name taken by a concurrent create reads as the same refusal as one taken before. */
  private async writing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (isKnown(e, 'P2002')) throw new UserGroupRefused('name_taken');
      throw e;
    }
  }

  private async audit(
    tx: Tx,
    actor: UserGroupActor,
    tenantId: string,
    action: 'user_group_create' | 'user_group_update' | 'user_group_delete' | 'user_group_member_add' | 'user_group_member_remove',
    id: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        tenantId,
        adminId: actor.adminId,
        action,
        targetEntityType: 'user_group',
        targetEntityId: id,
        oldValue: before ? (before as Prisma.InputJsonValue) : Prisma.DbNull,
        newValue: after ? (after as Prisma.InputJsonValue) : Prisma.DbNull,
        adminIpAddress: actor.ip,
      },
    });
  }
}
