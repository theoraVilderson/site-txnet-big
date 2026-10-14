import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAction, AuditTargetType, type Prisma } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  SupportConsentRefused,
  SupportConsentRejection,
  TENANT_CEILING,
  TenantCapabilityName,
  holdsPermission,
  isPlatformKey,
  recordAccessChange,
  tenantTransaction,
  isPlatformTenant,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { AccessReader } from '../permissions/access.reader';
import { answerMoved } from '../permissions/access';
import { authorityOver, permissionsOf } from '../users/authority';
import { auditPersonAct } from '../users/person-act-audit';
import type { CreateRoleInput, UpdateRoleInput } from './role.schema';
import { RoleScope, RoleView, RolesService } from './roles.service';
import { wildcardRefusal } from './superadmin-cap';
import { type KeyPerson, type KeyWindowRejection, type KeyWrite, type PersonKeys, PERSON, keyWindowRefusal, personKeysOf, storedWindow } from './user-keys.view';

export type { KeyEffect, KeyOverride, PersonKeys } from './user-keys.view';

/** The door's refusals and this surface's own, in one union (F-066-w5's shape). */
export type TenantRolesRejection =
  | ResellerAccessRejection
  | SupportConsentRejection
  | 'user_not_found'
  | 'role_not_found'
  | 'role_not_held'
  | 'no_authority'
  | 'key_unknown'
  | 'key_not_grantable'
  | 'key_not_held'
  | 'key_on_wildcard'
  | 'key_not_found'
  | 'superadmin_limit'
  | KeyWindowRejection;

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

type Tx = Prisma.TransactionClient;

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
 * one bound added on a reseller: the tenant ceiling — every key the
 * permission registry does not mark platform-only, which is the rule
 * `forward-auth` applies to a tenant-made role, read from the same file
 * (AC-1-e). The owner holds no operator
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
    /** A person's whole answer (ADR-0138): what the authority rule weighs, and what a key write moves. */
    private readonly answers: AccessReader,
    private readonly config: ConfigService,
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

  update(actor: ResellerActor, tenantId: string, id: string, input: UpdateRoleInput, ip: string) {
    return this.run(actor, tenantId, 'staffWrite', async (admitted) =>
      this.roles.update(await this.grantScope(actor, admitted), id, input, { userId: actor.userId, ip }),
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
        const max = Number(this.config.get('SUPERADMIN_MAX'));
        if (await wildcardRefusal(tx, { roleKeys: permissionsOf({ role }), tenantId: admitted.id, userId, max })) throw new TenantRolesRefused('superadmin_limit', String(max));
        // In the tenant's scope: someone of another tenant is simply not found.
        const user = await tx.user.findFirst({
          where: { id: userId, deletedAt: null },
          select: { id: true, tenantId: true, roleId: true, role: { select: { name: true, ...KEYS } } },
        });
        if (!user) throw new TenantRolesRefused('user_not_found', userId);
        const refused = authorityOver(
          { userId: actor.userId, permissions: actor.permissions, as: admitted.as },
          { userId: user.id, permissions: (await this.answers.ofLoaded(user, tx)).keys },
          { ownerUserId: tenant?.ownerUserId ?? null, platform: isPlatformTenant(tenant?.tenantType) },
        );
        if (refused) throw new TenantRolesRefused('no_authority', `${userId}: ${refused}`);

        const answer = { userId, role: { id: role.id, name: role.name } };
        // Idempotent: the second click of a button is not a second audit row.
        if (user.roleId === role.id) return answer;

        await tx.user.update({ where: { id: userId }, data: { roleId: role.id } });
        const act = await tx.adminAuditLog.create({
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
          select: { id: true },
        });
        // AC-1-q: their panel moves now, not on the next refused call (F-101-c); AC-1-p: their history keeps it.
        await recordAccessChange(tx, [
          { userId, tenantId: admitted.id, cause: 'role_set', actorUserId: actor.userId, auditLogId: act.id, detail: { role: role.name } },
        ]);
        return answer;
      });
    });
  }

  /** One person's keys by source (AC-1-l): what the Permissions section shows (AC-1-n). */
  keysOf(actor: ResellerActor, tenantId: string, userId: string): Promise<PersonKeys> {
    return this.run(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => personKeysOf(this.answers, tx, await this.person(tx, userId))),
    );
  }

  /**
   * Give or take one key on one person, with a reason (AC-1-l, ADR-0138 (7)),
   * a give for a window if it names one (F-030-a, {@link keyWindowRefusal}):
   * `KeyWindowSweep` tells the person when it opens and closes. The key must exist, be neither `*` nor a `platform.` key,
   * and be one this writer may grant — a take too, or a member could strip a
   * key they could never give back. The person must not hold `*`, and the
   * writer must have authority over their whole answer (ADR-0103). The same
   * key, effect, reason and window again writes nothing.
   */
  setKey(actor: ResellerActor, tenantId: string, userId: string, key: string, input: KeyWrite, ip: string): Promise<PersonKeys> {
    const now = new Date();
    const refused = keyWindowRefusal(input, now);
    if (refused) return Promise.reject(new TenantRolesRefused(refused, key));
    const window = storedWindow(input, now);
    return this.writingKey(actor, tenantId, userId, key, ip, async (tx, person, permissionId) => {
      const current = await tx.userPermission.findUnique({ where: { userId_permissionId: { userId, permissionId } } });
      const same = (a: Date | null, b: Date | null) => a?.getTime() === b?.getTime();
      if (current && current.effect === input.effect && current.reason === input.reason && same(current.startsAt, window.startsAt) && same(current.endsAt, window.endsAt)) return null;
      // A start moved or cleared is told afresh: the sweep marks `openedAt` when it passes.
      const data = { effect: input.effect, reason: input.reason, grantedByUserId: actor.userId, ...window, openedAt: null as Date | null };
      await tx.userPermission.upsert({
        where: { userId_permissionId: { userId, permissionId } },
        create: { userId, permissionId, tenantId: person.tenantId, ...data },
        update: data,
      });
      return {
        action: AdminAction.user_permission_set,
        before: current ? { key, ...overrideAudit(current) } : null,
        after: { key, ...overrideAudit({ effect: input.effect, reason: input.reason, ...window }) },
      };
    });
  }

  /** Lift a key given or taken, by hand (AC-1-l). The person's role decides that key again. */
  liftKey(actor: ResellerActor, tenantId: string, userId: string, key: string, ip: string): Promise<PersonKeys> {
    return this.writingKey(actor, tenantId, userId, key, ip, async (tx, _person, permissionId) => {
      const current = await tx.userPermission.findUnique({ where: { userId_permissionId: { userId, permissionId } } });
      if (!current) throw new TenantRolesRefused('key_not_found', `${userId}: ${key}`);
      await tx.userPermission.deleteMany({ where: { userId, permissionId } });
      return { action: AdminAction.user_permission_lift, before: { key, ...overrideAudit(current) }, after: null };
    });
  }

  /**
   * The checks every key write asks, the write, its audit row and the person's
   * `access.changed` — carrying what their answer actually gained and lost, so
   * a gift of a key the role already gives tells them nothing new.
   */
  private writingKey(
    actor: ResellerActor,
    tenantId: string,
    userId: string,
    key: string,
    ip: string,
    write: (
      tx: Tx,
      person: KeyPerson,
      permissionId: string,
    ) => Promise<{ action: AdminAction; before: Record<string, string> | null; after: Record<string, string> | null } | null>,
  ): Promise<PersonKeys> {
    return this.run(actor, tenantId, 'staffWrite', async (admitted) => {
      if (key === '*' || isPlatformKey(key)) throw new TenantRolesRefused('key_not_grantable', key);
      const scope = await this.grantScope(actor, admitted);
      const tenant = await this.prisma.tenant.findUnique({ where: { id: admitted.id }, select: { ownerUserId: true, tenantType: true } });

      return tenantTransaction(this.prisma, async (tx) => {
        // A typo is named as one, even to a `*` writer who holds every key that exists.
        const permission = await tx.permission.findUnique({ where: { key }, select: { id: true } });
        if (!permission) throw new TenantRolesRefused('key_unknown', key);
        if (!holdsPermission(scope.permissions, key)) throw new TenantRolesRefused('key_not_held', key);
        const person = await this.person(tx, userId);
        if (holdsPermission(permissionsOf(person), '*')) throw new TenantRolesRefused('key_on_wildcard', userId);
        const before = await this.answers.ofLoaded(person, tx);
        const refused = authorityOver(
          { userId: actor.userId, permissions: actor.permissions, as: admitted.as },
          { userId, permissions: before.keys },
          { ownerUserId: tenant?.ownerUserId ?? null, platform: isPlatformTenant(tenant?.tenantType) },
        );
        if (refused) throw new TenantRolesRefused('no_authority', `${userId}: ${refused}`);

        const change = await write(tx, person, permission.id);
        if (change) {
          const at = { tenantId: admitted.id, adminId: actor.userId, userId, ip };
          const act = await auditPersonAct(tx, at, { ...change, reason: change.after?.['reason'] ?? null });
          const after = await this.answers.ofLoaded(person, tx);
          // AC-1-q: their panel moves now; the trigger moves their token (ADR-0138 (5)). AC-1-p: their history keeps it.
          await recordAccessChange(tx, [
            { userId, tenantId: admitted.id, cause: 'keys_set', actorUserId: actor.userId, auditLogId: act.id, detail: answerMoved(before, after) },
          ]);
        }
        return personKeysOf(this.answers, tx, person);
      });
    });
  }

  /** In the tenant's scope: someone of another tenant is simply not found. */
  private async person(tx: Tx, userId: string) {
    const person = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: PERSON });
    if (!person) throw new TenantRolesRefused('user_not_found', userId);
    return person;
  }

  /**
   * The tenant, and the keys this writer may put on a role in it (ADR-0134).
   * The platform's tenant: the caller's own keys, `*` included — invariant 18
   * as `/auth/roles` applies it. A reseller: the tenant ceiling, whole for its
   * owner, and only the part they hold for anyone else.
   */
  private async grantScope(actor: ResellerActor, admitted: AdmittedReseller): Promise<RoleScope> {
    if (admitted.platform) return { tenantId: admitted.id, permissions: actor.permissions };
    const ceiling = this.tenantCeiling();
    const permissions =
      admitted.as === 'owner' ? ceiling : ceiling.filter((key) => holdsPermission(actor.permissions, key));
    return { tenantId: admitted.id, permissions };
  }

  /**
   * Every key a tenant-made role may ever claim: the registry's keys that are
   * not platform-only (AC-1-e). It was the keys the templates hold in the
   * database, which made a key grantable only by granting it to every holder
   * of a template; the registry is `permissions.yaml`, the gate's own ceiling
   * (F-018-n2), so the two can no longer disagree.
   */
  private tenantCeiling(): string[] {
    return [...TENANT_CEILING];
  }

  /** Admit, run in the tenant's scope, and translate the door's refusal into this surface's one type. */
  private async run<T>(
    actor: ResellerActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (admitted: AdmittedReseller) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.access.for('role.manage').runIncludingPlatform(actor, tenantId, capability, work);
    } catch (err) {
      if (err instanceof ResellerAccessRefused || err instanceof SupportConsentRefused) {
        throw new TenantRolesRefused(err.reason, tenantId);
      }
      throw err;
    }
  }
}

/** An override as its audit row keeps it (AC-1-l); a window's ends only when it has them (F-030-a). */
function overrideAudit(row: { effect: string; reason: string; startsAt: Date | null; endsAt: Date | null }): Record<string, string> {
  const ends = Object.entries({ startsAt: row.startsAt, endsAt: row.endsAt }).flatMap(([k, v]) => (v ? [[k, v.toISOString()]] : []));
  return { effect: row.effect, reason: row.reason, ...Object.fromEntries(ends) };
}
