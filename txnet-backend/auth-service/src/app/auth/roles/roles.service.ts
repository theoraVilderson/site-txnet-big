import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma } from '@prisma/client';
import { BackendI18nKeys, holdsPermission, isPlatformKey, ok, recordAccessChange, tenantTransaction } from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateRoleInput, UpdateRoleInput } from './role.schema';

/** The permission every route here needs (F-018-n). A tenant administers its own roles with it. */
export const ROLE_MANAGE = 'role.manage';

/**
 * Whose roles, and what the writer may put on one. From `/auth/roles` it is
 * the caller's claims as they are; on a tenant's path (F-1201-a) `permissions`
 * is what `TenantRolesService` computed may be granted there — the tenant
 * ceiling on a reseller (ADR-0134).
 */
export type RoleScope = { tenantId: string; permissions: readonly string[] };

/** Who made an edit, and from where: what its audit row records (AC-1-p). */
export type RoleEditor = { userId: string; ip: string };

/** One role as the caller sees it. A template is readable by everyone and writable by no one. */
export type RoleView = {
  id: string;
  name: string;
  isTemplate: boolean;
  isSystemRole: boolean;
  permissions: string[];
};

/** Exactly the relation `permissionFingerprint` runs over, so a view and a token agree. */
const ROLE_VIEW = {
  id: true,
  tenantId: true,
  name: true,
  isSystemRole: true,
  rolePermissions: { select: { permission: { select: { key: true } } } },
} as const;

type RoleRow = {
  id: string;
  tenantId: string | null;
  name: string;
  isSystemRole: boolean;
  rolePermissions: { permission: { key: string } }[];
};

/**
 * A tenant creates and edits its own roles (F-018-n, ADR-0062, D-42 (2)).
 *
 * `role` is deliberately **not** in `TENANT_SCOPED_MODELS`: a system template
 * (`tenantId = null`) belongs to no tenant and every tenant must still read it,
 * so the ambient scope would hide exactly the rows that have to stay visible.
 * The scope is applied here instead, and in one shape — a read is
 * `{OR: [own, template]}`, a write is `{tenantId: <the caller's own>}`.
 *
 * **Every query is in a `tenantTransaction`.** `role` is policied shared-read
 * (`data-model.md`): with no `app.tenant_id` bound, a read sees the templates
 * alone and an insert is refused by `WITH CHECK`. The ambient tenant is the
 * scope's — the gate's on `/auth/roles`, the admitted one on a tenant's path.
 *
 * **Redis is not written here.** A grant change is `role_permission` rows; the
 * Postgres trigger notifies and `PermissionNotificationsListener` rewrites
 * `role:<id>:permissions` (invariant #14). One transaction per change, so a
 * replaced grant set wakes the listener once — Postgres folds the notification.
 */
@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own roles and the system templates, in that order. */
  async list(scope: RoleScope) {
    return ok({ roles: await this.views(scope) }, BackendI18nKeys.errors.role.list);
  }

  /** {@link list}'s rows without the envelope — `TenantRolesService` adds what a tenant's page needs. */
  async views(scope: RoleScope): Promise<RoleView[]> {
    const rows = (await tenantTransaction(this.prisma, (tx) =>
      tx.role.findMany({
        where: { OR: [{ tenantId: scope.tenantId }, { tenantId: null }] },
        select: ROLE_VIEW,
        orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
      }),
    )) as RoleRow[];
    return rows.map(toView);
  }

  async create(scope: RoleScope, input: CreateRoleInput) {
    const permissionIds = await this.grantable(scope, input.permissions);
    const role = await tenantTransaction(this.prisma, async (tx) => {
      const created = await tx.role.create({
        data: { tenantId: scope.tenantId, name: input.name, isSystemRole: false },
        select: ROLE_VIEW,
      });
      await this.setGrants(tx, created.id, permissionIds);
      return created as RoleRow;
    });
    return ok({ role: toView({ ...role, rolePermissions: keysOf(input.permissions) }) }, BackendI18nKeys.errors.role.created);
  }

  async update(scope: RoleScope, id: string, input: UpdateRoleInput, by: RoleEditor) {
    const permissionIds = input.permissions ? await this.grantable(scope, input.permissions) : null;

    const role = await tenantTransaction(this.prisma, async (tx) => {
      const existing = await this.ownRole(tx, scope, id);
      const updated =
        input.name === undefined
          ? existing
          : ((await tx.role.update({ where: { id }, data: { name: input.name }, select: ROLE_VIEW })) as RoleRow);
      if (permissionIds) {
        await this.setGrants(tx, id, permissionIds);
        const before = new Set(existing.rolePermissions.map((rp) => rp.permission.key));
        const after = new Set(input.permissions);
        const keys = { given: [...after].filter((key) => !before.has(key)), taken: [...before].filter((key) => !after.has(key)) };
        // The same set again moves nobody: no audit row, nobody told.
        if (keys.given.length > 0 || keys.taken.length > 0) {
          const act = await tx.adminAuditLog.create({
            data: {
              tenantId: scope.tenantId,
              adminId: by.userId,
              action: AdminAction.role_keys_set,
              targetEntityType: AuditTargetType.role,
              targetEntityId: id,
              oldValue: { keys: [...before].sort() },
              newValue: { keys: [...after].sort() },
              adminIpAddress: by.ip,
            },
            select: { id: true },
          });
          await this.tellHolders(tx, scope, id, keys, by, act.id);
        }
      }
      return updated;
    });

    const permissions = input.permissions ?? role.rolePermissions.map((rp) => rp.permission.key);
    return ok({ role: toView({ ...role, rolePermissions: keysOf(permissions) }) }, BackendI18nKeys.errors.role.updated);
  }

  /**
   * A role still held by a user is refused rather than orphaning that user:
   * `user.roleId` is a NOT NULL FK (invariant #5), so there is nothing to move
   * them to that this endpoint could choose for the caller.
   */
  async remove(scope: RoleScope, id: string) {
    await tenantTransaction(this.prisma, async (tx) => {
      await this.ownRole(tx, scope, id);
      const held = await tx.user.count({ where: { roleId: id } });
      // A group giving the role (AC-1-m) holds it too: its members would lose
      // it silently. A tenant's own role is only ever its own groups'.
      const given = await tx.userGroup.count({ where: { roleId: id } });
      if (held > 0 || given > 0) throw new ConflictException(BackendI18nKeys.errors.role.inUse);
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.role.delete({ where: { id } });
    });
    return ok({ id }, BackendI18nKeys.errors.role.deleted);
  }

  /**
   * A role the caller's own tenant owns. A template and another tenant's role
   * both answer `notFound` — the same answer, so this is not an oracle for
   * whether a role id exists somewhere else on the platform. It is also what
   * keeps invariant #9 (`isSystemRole` is never deleted): a template is never
   * found here, and a tenant's own role is never a system role.
   */
  private async ownRole(tx: Prisma.TransactionClient, scope: RoleScope, id: string): Promise<RoleRow> {
    const role = (await tx.role.findFirst({
      where: { id, tenantId: scope.tenantId },
      select: ROLE_VIEW,
    })) as RoleRow | null;
    if (!role) throw new NotFoundException(BackendI18nKeys.errors.role.notFound);
    return role;
  }

  /**
   * The keys a caller may put on a role are the keys it holds itself; `*`
   * (SuperAdmin) may grant any key that exists. Without this, `role.manage`
   * alone would be the whole platform: a reseller writes the grants of the
   * roles its own staff hold, so it could mint a key no tenant role may hold for itself.
   *
   * A key with no `permission` row is refused for everyone — a typo must not
   * become a grant that silently means nothing.
   *
   * A platform key is refused on every role written here, `*` included: they
   * are all tenant-made roles, and the platform's set is never granted to one
   * (AC-1-c, catalog §3.3, ADR-0135). The gate would refuse the claim anyway
   * (F-018-n2); refusing the write keeps a role from holding a key it can
   * never use.
   */
  private async grantable(scope: RoleScope, keys: string[]): Promise<string[]> {
    const wanted = [...new Set(keys)];
    if (wanted.some(isPlatformKey)) {
      throw new ForbiddenException(BackendI18nKeys.errors.role.permissionPlatformOnly);
    }
    const rows = await this.prisma.permission.findMany({
      where: { key: { in: wanted } },
      select: { id: true, key: true },
    });
    if (rows.length !== wanted.length) {
      throw new BadRequestException(BackendI18nKeys.errors.role.permissionUnknown);
    }
    for (const key of wanted) {
      if (!holdsPermission(scope.permissions, key)) {
        throw new ForbiddenException(BackendI18nKeys.errors.role.permissionNotHeld);
      }
    }
    return rows.map((row) => row.id);
  }

  /**
   * AC-1-q: everyone holding a role whose keys were replaced hears it, one
   * outbox row each, in the edit's transaction; AC-1-p: and one history row
   * each, pointing at the edit's audit row. A rename moves no access and
   * tells no one. In the tenant's scope, so the holders are this tenant's.
   * `keys` is what the edit gave and took, for the notice (AC-1-s).
   */
  private async tellHolders(
    tx: Prisma.TransactionClient,
    scope: RoleScope,
    roleId: string,
    keys: { given: string[]; taken: string[] },
    by: RoleEditor,
    auditLogId: string,
  ): Promise<void> {
    const holders = await tx.user.findMany({ where: { roleId, deletedAt: null }, select: { id: true } });
    await recordAccessChange(
      tx,
      holders.map((h) => ({ userId: h.id, tenantId: scope.tenantId, cause: 'role_edited' as const, actorUserId: by.userId, auditLogId, detail: keys })),
    );
  }

  /** The whole grant set, replaced: the fingerprint is over a set, not a diff. */
  private async setGrants(
    tx: { rolePermission: { deleteMany: (a: unknown) => Promise<unknown>; createMany: (a: unknown) => Promise<unknown> } },
    roleId: string,
    permissionIds: string[],
  ): Promise<void> {
    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (permissionIds.length > 0) {
      await tx.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId, permissionId })) });
    }
  }
}

function toView(role: RoleRow): RoleView {
  return {
    id: role.id,
    name: role.name,
    isTemplate: role.tenantId === null,
    isSystemRole: role.isSystemRole,
    permissions: role.rolePermissions.map((rp) => rp.permission.key),
  };
}

function keysOf(keys: string[]): { permission: { key: string } }[] {
  return keys.map((key) => ({ permission: { key } }));
}
