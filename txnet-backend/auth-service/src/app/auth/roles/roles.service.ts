import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BackendI18nKeys, holdsPermission, ok } from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthClaims } from '../token.service';
import type { CreateRoleInput, UpdateRoleInput } from './role.schema';

/** The permission every route here needs (F-018-n). A tenant administers its own roles with it. */
export const ROLE_MANAGE = 'role.manage';

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
 * **Redis is not written here.** A grant change is `role_permission` rows; the
 * Postgres trigger notifies and `PermissionNotificationsListener` rewrites
 * `role:<id>:permissions` (invariant #14). One transaction per change, so a
 * replaced grant set wakes the listener once — Postgres folds the notification.
 */
@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own roles and the system templates, in that order. */
  async list(claims: AuthClaims) {
    const rows = (await this.prisma.role.findMany({
      where: { OR: [{ tenantId: claims.tenantId }, { tenantId: null }] },
      select: ROLE_VIEW,
      orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
    })) as RoleRow[];
    return ok({ roles: rows.map(toView) }, BackendI18nKeys.errors.role.list);
  }

  async create(claims: AuthClaims, input: CreateRoleInput) {
    const permissionIds = await this.grantable(claims, input.permissions);
    const role = await this.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: { tenantId: claims.tenantId, name: input.name, isSystemRole: false },
        select: ROLE_VIEW,
      });
      await this.setGrants(tx, created.id, permissionIds);
      return created as RoleRow;
    });
    return ok({ role: toView({ ...role, rolePermissions: keysOf(input.permissions) }) }, BackendI18nKeys.errors.role.created);
  }

  async update(claims: AuthClaims, id: string, input: UpdateRoleInput) {
    const existing = await this.ownRole(claims, id);
    const permissionIds = input.permissions ? await this.grantable(claims, input.permissions) : null;

    const role = await this.prisma.$transaction(async (tx) => {
      const updated =
        input.name === undefined
          ? existing
          : ((await tx.role.update({ where: { id }, data: { name: input.name }, select: ROLE_VIEW })) as RoleRow);
      if (permissionIds) await this.setGrants(tx, id, permissionIds);
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
  async remove(claims: AuthClaims, id: string) {
    await this.ownRole(claims, id);
    const held = await this.prisma.user.count({ where: { roleId: id } });
    if (held > 0) throw new ConflictException(BackendI18nKeys.errors.role.inUse);

    await this.prisma.$transaction(async (tx) => {
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
  private async ownRole(claims: AuthClaims, id: string): Promise<RoleRow> {
    const role = (await this.prisma.role.findFirst({
      where: { id, tenantId: claims.tenantId },
      select: ROLE_VIEW,
    })) as RoleRow | null;
    if (!role) throw new NotFoundException(BackendI18nKeys.errors.role.notFound);
    return role;
  }

  /**
   * The keys a caller may put on a role are the keys it holds itself; `*`
   * (SuperAdmin) may grant any key that exists. Without this, `role.manage`
   * alone would be the whole platform: a reseller writes the grants of the
   * roles its own staff hold, so it could mint `tenant.manage` for itself.
   *
   * A key with no `permission` row is refused for everyone — a typo must not
   * become a grant that silently means nothing.
   */
  private async grantable(claims: AuthClaims, keys: string[]): Promise<string[]> {
    const wanted = [...new Set(keys)];
    const rows = await this.prisma.permission.findMany({
      where: { key: { in: wanted } },
      select: { id: true, key: true },
    });
    if (rows.length !== wanted.length) {
      throw new BadRequestException(BackendI18nKeys.errors.role.permissionUnknown);
    }
    for (const key of wanted) {
      if (!holdsPermission(claims.permissions, key)) {
        throw new ForbiddenException(BackendI18nKeys.errors.role.permissionNotHeld);
      }
    }
    return rows.map((row) => row.id);
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
