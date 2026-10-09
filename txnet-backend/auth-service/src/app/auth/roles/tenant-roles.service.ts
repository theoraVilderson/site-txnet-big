import { Injectable } from '@nestjs/common';
import { AdminAction, AuditTargetType, TenantType } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  ALL_PERMISSIONS,
  SupportConsentRefused,
  SupportConsentRejection,
  TenantCapabilityName,
  accessChanged,
  holdsPermission,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { authorityOver, permissionsOf } from '../users/authority';
import type { CreateRoleInput, UpdateRoleInput } from './role.schema';
import { RoleScope, RoleView, RolesService } from './roles.service';

/** The door's refusals and this surface's own, in one union (F-066-w5's shape). */
export type TenantRolesRejection =
  | ResellerAccessRejection
  | SupportConsentRejection
  | 'user_not_found'
  | 'role_not_found'
  | 'role_not_held'
  | 'no_authority';

export class TenantRolesRefused extends Error {
  constructor(
    readonly reason: TenantRolesRejection,
    detail = '',
  ) {
    super(`tenant roles refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantRolesRefused';
  }
}

/** A role on a tenant's page: {@link RoleView} and how many of this tenant's people hold it. */
export type TenantRoleView = RoleView & { members: number };

/** What the Roles page reads: the roles, and the keys this caller may tick on one. */
export type TenantRolesList = { roles: TenantRoleView[]; grantable: string[] };

export type RoleAssignment = { userId: string; role: { id: string; name: string } };

const KEYS = { rolePermissions: { select: { permission: { select: { key: true } } } } } as const;

/**
 * A tenant's roles and who holds them, on the tenant's own path (F-1201-a,
 * ADR-0134): `/api/auth/tenants/:tenantId/roles` and
 * `/api/auth/tenants/:tenantId/users/:userId/role`.
 *
 * **The tenant is the path's**, admitted by `ResellerAccess` exactly as the
 * reseller users-admin is (F-311-a): a reseller's owner is a user of the
 * platform's tenant (ADR-0059), so `/auth/roles`, which acts on the caller's
 * own tenant, could never reach their reseller. The platform's own tenant is
 * admitted to its staff by the same door, so one surface serves both teams.
 *
 * **What may be granted** ({@link grantScope}) is identity invariant 18 with
 * one bound added on a reseller: the tenant ceiling — every concrete key the
 * templates name, the database's half of the rule
 * `forward-auth` applies to a tenant-made role. The owner holds no operator
 * key of their own (they are the platform's customer), so they grant the
 * whole ceiling; a member or the platform's staff grant the part they hold.
 *
 * Writes go through {@link RolesService}, so a role's rules live once.
 * Assigning one writes `user.roleId` only: the trigger notifies and the
 * listener moves the token (F-101-b) — nothing here touches Redis.
 */
@Injectable()
export class TenantRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly roles: RolesService,
  ) {}

  list(actor: ResellerActor, tenantId: string): Promise<TenantRolesList> {
    return this.run(actor, tenantId, 'read', async (admitted) => {
      const scope = await this.grantScope(actor, admitted);
      const [views, held] = await Promise.all([
        this.roles.views(scope),
        // In the tenant's scope, so RLS counts this tenant's people only — a
        // template's count is how many here hold it, not the platform's.
        tenantTransaction(this.prisma, (tx) =>
          tx.user.groupBy({ by: ['roleId'], where: { deletedAt: null }, _count: { _all: true } }),
        ),
      ]);
      const members = new Map(held.map((row) => [row.roleId, row._count._all]));
      return {
        roles: views.map((view) => ({ ...view, members: members.get(view.id) ?? 0 })),
        grantable: [...scope.permissions].sort(),
      };
    });
  }

  create(actor: ResellerActor, tenantId: string, input: CreateRoleInput) {
    return this.run(actor, tenantId, 'staffWrite', async (admitted) =>
      this.roles.create(await this.grantScope(actor, admitted), input),
    );
  }

  update(actor: ResellerActor, tenantId: string, id: string, input: UpdateRoleInput) {
    return this.run(actor, tenantId, 'staffWrite', async (admitted) =>
      this.roles.update(await this.grantScope(actor, admitted), id, input),
    );
  }

  remove(actor: ResellerActor, tenantId: string, id: string) {
    return this.run(actor, tenantId, 'staffWrite', async (admitted) =>
      this.roles.remove(await this.grantScope(actor, admitted), id),
    );
  }

  /**
   * Give one of this tenant's people a role of this tenant or a template.
   * Two questions, both before the write: does the writer hold every key of
   * the role (invariant 18 — or they could hand out what they cannot grant),
   * and do they have authority over this person (ADR-0103, invariant 18 of the
   * person rules — or a peer could demote a peer, or anyone the owner).
   */
  assign(actor: ResellerActor, tenantId: string, userId: string, roleId: string, ip: string): Promise<RoleAssignment> {
    return this.run(actor, tenantId, 'staffWrite', async (admitted) => {
      const scope = await this.grantScope(actor, admitted);
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: admitted.id },
        select: { ownerUserId: true, tenantType: true },
      });

      return tenantTransaction(this.prisma, async (tx) => {
        // Bound to the tenant, or RLS shows the templates alone (`RolesService`'s note).
        const role = await tx.role.findFirst({
          where: { id: roleId, OR: [{ tenantId: admitted.id }, { tenantId: null }] },
          select: { id: true, name: true, ...KEYS },
        });
        // Another tenant's role answers as one that never existed (identity invariant 9's reason).
        if (!role) throw new TenantRolesRefused('role_not_found', roleId);
        if (!permissionsOf({ role }).every((key) => holdsPermission(scope.permissions, key))) {
          throw new TenantRolesRefused('role_not_held', roleId);
        }
        // In the tenant's scope: someone of another tenant is simply not found.
        const user = await tx.user.findFirst({
          where: { id: userId, deletedAt: null },
          select: { id: true, roleId: true, role: { select: { name: true, ...KEYS } } },
        });
        if (!user) throw new TenantRolesRefused('user_not_found', userId);
        const refused = authorityOver(
          { userId: actor.userId, permissions: actor.permissions, as: admitted.as },
          { userId: user.id, permissions: permissionsOf(user) },
          { ownerUserId: tenant?.ownerUserId ?? null, platform: tenant?.tenantType === TenantType.platform_owner },
        );
        if (refused) throw new TenantRolesRefused('no_authority', `${userId}: ${refused}`);

        const answer = { userId, role: { id: role.id, name: role.name } };
        // Idempotent: the second click of a button is not a second audit row.
        if (user.roleId === role.id) return answer;

        await tx.user.update({ where: { id: userId }, data: { roleId: role.id } });
        await tx.adminAuditLog.create({
          data: {
            tenantId: admitted.id,
            adminId: actor.userId,
            action: AdminAction.role_change,
            targetEntityType: AuditTargetType.user,
            targetEntityId: userId,
            oldValue: { roleId: user.roleId, roleName: user.role?.name ?? null },
            newValue: { roleId: role.id, roleName: role.name },
            adminIpAddress: ip,
          },
        });
        // AC-1-q: their panel moves now, not on the next refused call (F-101-c).
        await tx.outboxEvent.create({ data: accessChanged(userId, admitted.id, 'role_set'), select: { id: true } });
        return answer;
      });
    });
  }

  /**
   * The tenant, and the keys this writer may put on a role in it (ADR-0134).
   * The platform's tenant: the caller's own keys, `*` included — invariant 18
   * as `/auth/roles` applies it. A reseller: the tenant ceiling, whole for its
   * owner, and only the part they hold for anyone else.
   */
  private async grantScope(actor: ResellerActor, admitted: AdmittedReseller): Promise<RoleScope> {
    if (admitted.platform) return { tenantId: admitted.id, permissions: actor.permissions };
    const ceiling = await this.tenantCeiling();
    const permissions =
      admitted.as === 'owner' ? ceiling : ceiling.filter((key) => holdsPermission(actor.permissions, key));
    return { tenantId: admitted.id, permissions };
  }

  /**
   * Every concrete key a template names — what a tenant-made role may ever
   * claim. `*` is not a key but "all of them", so it is left out: SuperAdmin
   * holds nothing else, which is how it stays out of every tenant's reach.
   */
  private async tenantCeiling(): Promise<string[]> {
    const templates = await this.prisma.role.findMany({ where: { tenantId: null }, select: KEYS });
    const keys = new Set(templates.flatMap((template) => permissionsOf({ role: template })));
    keys.delete(ALL_PERMISSIONS);
    return [...keys];
  }

  /** Admit, run in the tenant's scope, and translate the door's refusal into this surface's one type. */
  private async run<T>(
    actor: ResellerActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (admitted: AdmittedReseller) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.access.runIncludingPlatform(actor, tenantId, capability, work);
    } catch (err) {
      if (err instanceof ResellerAccessRefused || err instanceof SupportConsentRefused) {
        throw new TenantRolesRefused(err.reason, tenantId);
      }
      throw err;
    }
  }
}
