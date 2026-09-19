import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RolesService } from './roles.service';
import type { AuthClaims } from '../token.service';

/**
 * Tenant-scoped roles (F-018-n, ADR-0062, D-42 (2)). What this spec pins:
 *
 * - **A reseller sees its own roles and the system templates, and writes only
 *   its own.** A template and another tenant's role answer the same `notFound`,
 *   so the endpoint is not a cross-tenant existence oracle.
 * - **No escalation.** A caller may grant only permission keys it holds itself;
 *   `*` (SuperAdmin) may grant any key that exists. Without this rule
 *   `role.manage` alone would be the whole platform, since a reseller writes
 *   the grants of the roles its own staff hold.
 * - **Redis is still written by the trigger, never here.** Every grant change
 *   is `role_permission` rows inside one transaction (invariant #14); the
 *   service writes no `role:<id>:permissions` key.
 */

const RESELLER: AuthClaims = {
  sub: 'owner-1',
  tenantId: 'tenant-reseller',
  roleId: 'role-owner',
  roleName: 'ResellerOwner',
  permissions: ['role.manage', 'wallet.view', 'user.view'],
  sessionId: 'session-1',
  iat: 0,
  exp: 0,
};

const SUPER: AuthClaims = { ...RESELLER, tenantId: 'tenant-platform', permissions: ['*'] };

const OWN_ROLE = {
  id: 'role-staff',
  tenantId: 'tenant-reseller',
  name: 'Support',
  isSystemRole: false,
  rolePermissions: [{ permission: { key: 'user.view' } }],
};

const TEMPLATE = {
  id: 'role-user',
  tenantId: null,
  name: 'user',
  isSystemRole: true,
  rolePermissions: [],
};

function harness(overrides: Record<string, unknown> = {}) {
  const tx = {
    role: {
      create: vi.fn().mockResolvedValue({ ...OWN_ROLE, id: 'role-new' }),
      update: vi.fn().mockResolvedValue(OWN_ROLE),
      delete: vi.fn().mockResolvedValue(OWN_ROLE),
    },
    rolePermission: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    role: {
      findMany: vi.fn().mockResolvedValue([OWN_ROLE, TEMPLATE]),
      findFirst: vi.fn().mockResolvedValue(OWN_ROLE),
    },
    permission: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { key: { in: string[] } } }) =>
        Promise.resolve(
          where.key.in
            .filter((key) => ['user.view', 'wallet.view', 'role.manage', 'tenant.manage'].includes(key))
            .map((key) => ({ id: `perm-${key}`, key })),
        ),
      ),
    },
    user: { count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    ...overrides,
  };
  return { prisma, tx, service: new RolesService(prisma as never) };
}

describe('RolesService', () => {
  describe('list', () => {
    it('reads the caller tenant and the templates, and nothing else', async () => {
      const { prisma, service } = harness();
      const result = await service.list(RESELLER);
      expect(prisma.role.findMany.mock.calls[0][0].where).toEqual({
        OR: [{ tenantId: 'tenant-reseller' }, { tenantId: null }],
      });
      expect(result.data.roles).toEqual([
        { id: 'role-staff', name: 'Support', isTemplate: false, isSystemRole: false, permissions: ['user.view'] },
        { id: 'role-user', name: 'user', isTemplate: true, isSystemRole: true, permissions: [] },
      ]);
    });
  });

  describe('create', () => {
    it('stamps the caller tenant on the row and grants inside one transaction', async () => {
      const { prisma, tx, service } = harness();
      await service.create(RESELLER, { name: 'Support', permissions: ['user.view'] });
      expect(prisma.$transaction).toHaveBeenCalledOnce();
      expect(tx.role.create.mock.calls[0][0].data).toEqual({
        tenantId: 'tenant-reseller',
        name: 'Support',
        isSystemRole: false,
      });
      expect(tx.rolePermission.createMany.mock.calls[0][0].data).toEqual([
        { roleId: 'role-new', permissionId: 'perm-user.view' },
      ]);
    });

    it('refuses a permission key the caller does not hold', async () => {
      const { prisma, service } = harness();
      await expect(
        service.create(RESELLER, { name: 'Support', permissions: ['tenant.manage'] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lets `*` grant any key that exists', async () => {
      const { tx, service } = harness();
      await service.create(SUPER, { name: 'Ops', permissions: ['tenant.manage'] });
      expect(tx.rolePermission.createMany.mock.calls[0][0].data).toEqual([
        { roleId: 'role-new', permissionId: 'perm-tenant.manage' },
      ]);
    });

    it('refuses a key no permission row defines, even for `*`', async () => {
      const { service } = harness();
      await expect(service.create(SUPER, { name: 'Ops', permissions: ['made.up'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('never writes a Redis permission key — the trigger does (invariant #14)', async () => {
      const { service } = harness();
      await service.create(RESELLER, { name: 'Support', permissions: ['user.view'] });
      expect(Object.keys(service as object)).not.toContain('redis');
    });
  });

  describe('update and delete', () => {
    it('looks the role up in the caller tenant, so a template is not writable', async () => {
      const { prisma, service } = harness();
      await service.update(RESELLER, 'role-staff', { name: 'Helpdesk' });
      expect(prisma.role.findFirst.mock.calls[0][0].where).toEqual({
        id: 'role-staff',
        tenantId: 'tenant-reseller',
      });
    });

    it('answers notFound for a template and for another tenant`s role alike', async () => {
      const { service } = harness({ role: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() } });
      await expect(service.update(RESELLER, 'role-user', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.remove(RESELLER, 'role-user')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('replaces the whole grant set in one transaction', async () => {
      const { prisma, tx, service } = harness();
      await service.update(RESELLER, 'role-staff', { permissions: ['wallet.view'] });
      expect(prisma.$transaction).toHaveBeenCalledOnce();
      expect(tx.rolePermission.deleteMany.mock.calls[0][0].where).toEqual({ roleId: 'role-staff' });
      expect(tx.rolePermission.createMany.mock.calls[0][0].data).toEqual([
        { roleId: 'role-staff', permissionId: 'perm-wallet.view' },
      ]);
    });

    it('leaves the grants alone when only the name changes', async () => {
      const { tx, service } = harness();
      await service.update(RESELLER, 'role-staff', { name: 'Helpdesk' });
      expect(tx.rolePermission.deleteMany).not.toHaveBeenCalled();
      expect(tx.role.update.mock.calls[0][0].data).toEqual({ name: 'Helpdesk' });
    });

    it('refuses to delete a role a user still holds', async () => {
      const { prisma, service } = harness({ user: { count: vi.fn().mockResolvedValue(3) } });
      await expect(service.remove(RESELLER, 'role-staff')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('deletes the grants with the role', async () => {
      const { tx, service } = harness();
      await service.remove(RESELLER, 'role-staff');
      expect(tx.rolePermission.deleteMany.mock.calls[0][0].where).toEqual({ roleId: 'role-staff' });
      expect(tx.role.delete.mock.calls[0][0].where).toEqual({ id: 'role-staff' });
    });
  });
});
