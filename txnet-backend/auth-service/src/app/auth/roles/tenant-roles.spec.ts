import { ForbiddenException } from '@nestjs/common';
import { PERMISSION_REGISTRY, runWithTenant } from '@txnet-backend/shared-core';
import { AccessReader } from '../permissions/access.reader';
import { RolesService } from './roles.service';
import { TenantRolesRefused, TenantRolesService } from './tenant-roles.service';

/**
 * A staff member gets a role (F-1201-a, ADR-0134). What this spec pins:
 *
 * - **The tenant is the path's**, admitted by `ResellerAccess` — a reseller's
 *   owner is a user of the platform's tenant (ADR-0059), so the caller's own
 *   tenant would be the wrong one.
 * - **What may be granted on a reseller is the tenant ceiling**: every
 *   concrete key the templates name, `*` excepted. The owner grants the whole ceiling;
 *   anyone else only the part of it they hold (identity invariant 18).
 * - **Assigning a role asks two questions**: does the writer hold every key of
 *   the role, and do they have authority over the person (ADR-0103).
 * - **The write is `user.roleId`, audited, in the tenant's scope** — the
 *   trigger moves the token (F-101-b); nothing here touches Redis.
 */
describe('TenantRolesService', () => {
  const reseller = 'aaaaaaaa-0000-4000-8000-000000000001';
  const owner = { userId: 'u-owner', tenantId: 'platform', permissions: ['self.read'] };
  const member = { userId: 'u-member', tenantId: reseller, permissions: ['platform.tenant.manage', 'support.agent'] };

  const keys = (...k: string[]) => k.map((key) => ({ permission: { key } }));
  const TEMPLATES = [
    { id: 'tpl-super', tenantId: null, name: 'SuperAdmin', isSystemRole: true, rolePermissions: keys('*') },
    { id: 'tpl-support', tenantId: null, name: 'Support', isSystemRole: true, rolePermissions: keys('support.agent', 'restriction.assign') },
    { id: 'tpl-user', tenantId: null, name: 'user', isSystemRole: true, rolePermissions: [] },
  ];
  const OWN = { id: 'role-desk', tenantId: reseller, name: 'Desk', isSystemRole: false, rolePermissions: keys('support.agent') };

  const build = (options: { as?: 'owner' | 'member' | 'staff'; platform?: boolean; target?: unknown; role?: unknown } = {}) => {
    const order: string[] = [];
    const written: { update?: unknown; audit?: { data: Record<string, unknown> }; outbox?: { data: Record<string, unknown> } } = {};
    const user = {
      findFirst: vi.fn(async () =>
        'target' in options
          ? options.target
          : { id: 'u-ali', roleId: 'tpl-user', role: { name: 'user', rolePermissions: [] } },
      ),
      update: vi.fn(async (args: unknown) => {
        order.push('update');
        written.update = args;
        return {};
      }),
      groupBy: vi.fn(async () => [{ roleId: 'role-desk', _count: { _all: 2 } }]),
      count: vi.fn(async () => 0),
    };
    const adminAuditLog = {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        order.push('audit');
        written.audit = args;
        return {};
      }),
    };
    const role = {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        'OR' in where ? [OWN, ...TEMPLATES] : TEMPLATES,
      ),
      findFirst: vi.fn(async (_args: unknown) => ('role' in options ? options.role : OWN)),
    };
    const $executeRaw = vi.fn(async () => {
      order.push('bind');
    });
    const outboxEvent = {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        order.push('outbox');
        written.outbox = args;
        return {};
      }),
    };
    // Nobody here has a key given or taken (AC-1-l): their answer is their role's.
    const userPermission = { findMany: vi.fn(async () => []) };
    const tx = { user, adminAuditLog, $executeRaw, role, outboxEvent, userPermission };
    const prisma = {
      ...tx,
      permission: {
        findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
          where.key.in.map((key) => ({ id: `perm-${key}`, key })),
        ),
      },
      tenant: { findUnique: vi.fn(async () => ({ ownerUserId: 'u-owner', tenantType: options.platform ? 'platform_owner' : 'reseller' })) },
      $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    };
    const access = {
      for() {
        return this;
      },
      runIncludingPlatform: vi.fn(async (_a: unknown, _t: unknown, capability: string, work: (r: unknown) => Promise<unknown>) => {
        order.push(`admit:${capability}`);
        return runWithTenant({ id: reseller }, () =>
          work({ id: reseller, slug: 'alpha', as: options.as ?? 'owner', ...(options.platform ? { platform: true } : {}) }),
        );
      }),
    };
    const service = new TenantRolesService(prisma as never, access as never, new RolesService(prisma as never), new AccessReader(prisma as never));
    return { service, order, user, role, adminAuditLog, written, access };
  };

  describe('what may be granted', () => {
    it("gives a reseller owner the tenant ceiling: the registry's keys less the platform-only ones (AC-1-e)", async () => {
      const { service } = build({ as: 'owner' });
      const { grantable } = await service.list(owner, reseller);
      const ceiling = PERMISSION_REGISTRY.filter((row) => !row.platformOnly).map((row) => row.permission);
      expect(grantable).toEqual([...ceiling].sort());
      // No template is granted the reseller keys, and they are grantable anyway.
      expect(grantable).toEqual(expect.arrayContaining(['domain.manage', 'theme.manage', 'staff.manage', 'role.manage']));
      expect(grantable).not.toContain('platform.tenant.manage');
      expect(grantable).not.toContain('*');
    });

    it('gives a member only the part of the ceiling they hold', async () => {
      const { service } = build({ as: 'member' });
      const { grantable } = await service.list(member, reseller);
      expect(grantable).toEqual(['support.agent']);
    });

    it('on the platform tenant, is the caller own keys, `*` included', async () => {
      const { service } = build({ as: 'staff', platform: true });
      const { grantable } = await service.list({ userId: 'u-boss', tenantId: reseller, permissions: ['*'] }, reseller);
      expect(grantable).toEqual(['*']);
    });

    it('lists roles with how many people of this tenant hold each', async () => {
      const { service } = build();
      const { roles } = await service.list(owner, reseller);
      expect(roles.find((r) => r.id === 'role-desk')).toMatchObject({ members: 2, isTemplate: false });
      expect(roles.find((r) => r.id === 'tpl-user')).toMatchObject({ members: 0, isTemplate: true });
    });

    it('refuses an owner who creates a role with a key past the ceiling', async () => {
      const { service } = build({ as: 'owner' });
      await expect(service.create(owner, reseller, { name: 'Boss', permissions: ['platform.tenant.manage'] })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('assign', () => {
    it('writes the role, audited as role_change, in the tenant scope, through `staffWrite`', async () => {
      const { service, order, written } = build({ as: 'owner' });
      const result = await service.assign(owner, reseller, 'u-ali', 'role-desk', '10.0.0.1');
      expect(result).toEqual({ userId: 'u-ali', role: { id: 'role-desk', name: 'Desk' } });
      expect(order).toEqual(['admit:staffWrite', 'bind', 'update', 'audit', 'outbox']);
      expect(written.update).toMatchObject({ where: { id: 'u-ali' }, data: { roleId: 'role-desk' } });
      expect(written.audit?.data).toMatchObject({
        tenantId: reseller,
        adminId: 'u-owner',
        action: 'role_change',
        targetEntityId: 'u-ali',
        oldValue: { roleId: 'tpl-user', roleName: 'user' },
        newValue: { roleId: 'role-desk', roleName: 'Desk' },
      });
    });

    it('tells the person in the same transaction: identity.access.changed on their channel (AC-1-q)', async () => {
      const { service, written } = build({ as: 'owner' });
      await service.assign(owner, reseller, 'u-ali', 'role-desk', '10.0.0.1');
      expect(written.outbox?.data).toEqual({
        aggregate: 'identity.access',
        aggregateId: 'u-ali',
        type: 'identity.access.changed',
        payload: { userId: 'u-ali', tenantId: reseller, cause: 'role_set', role: 'Desk' },
      });
    });

    it('reads the role among this tenant and the templates only', async () => {
      const { service, role } = build();
      await service.assign(owner, reseller, 'u-ali', 'role-desk', '10.0.0.1');
      expect(role.findFirst.mock.calls[0][0]).toMatchObject({
        where: { id: 'role-desk', OR: [{ tenantId: reseller }, { tenantId: null }] },
      });
    });

    it('refuses a role that is not found here', async () => {
      const { service, order } = build({ role: null });
      await expect(service.assign(owner, reseller, 'u-ali', 'role-x', '10.0.0.1')).rejects.toMatchObject({
        reason: 'role_not_found',
      });
      expect(order).not.toContain('update');
    });

    it('refuses a role holding a key the writer may not grant — SuperAdmin, for an owner', async () => {
      const { service, order } = build({ as: 'owner', role: TEMPLATES[0] });
      await expect(service.assign(owner, reseller, 'u-ali', 'tpl-super', '10.0.0.1')).rejects.toMatchObject({
        reason: 'role_not_held',
      });
      expect(order).not.toContain('update');
    });

    it('refuses a member with no authority over a peer who holds as much', async () => {
      const peer = { id: 'u-peer', roleId: 'role-desk', role: { name: 'Desk', rolePermissions: keys('platform.tenant.manage', 'support.agent') } };
      const { service, order } = build({ as: 'member', target: peer });
      await expect(service.assign(member, reseller, 'u-peer', 'role-desk', '10.0.0.1')).rejects.toBeInstanceOf(TenantRolesRefused);
      expect(order).not.toContain('update');
    });

    it('refuses the tenant owner as a target, to anyone', async () => {
      const target = { id: 'u-owner', roleId: 'tpl-user', role: { name: 'user', rolePermissions: [] } };
      const { service } = build({ as: 'staff', target });
      await expect(
        service.assign({ userId: 'u-boss', tenantId: 'platform', permissions: ['*'] }, reseller, 'u-owner', 'role-desk', '10.0.0.1'),
      ).rejects.toMatchObject({ reason: 'no_authority' });
    });

    it('refuses a person this tenant does not have', async () => {
      const { service } = build({ target: null });
      await expect(service.assign(owner, reseller, 'u-ghost', 'role-desk', '10.0.0.1')).rejects.toMatchObject({
        reason: 'user_not_found',
      });
    });

    it('is idempotent: the role they already hold writes no row and no audit', async () => {
      const target = { id: 'u-ali', roleId: 'role-desk', role: { name: 'Desk', rolePermissions: keys('support.agent') } };
      const { service, order } = build({ target });
      await service.assign(owner, reseller, 'u-ali', 'role-desk', '10.0.0.1');
      expect(order).not.toContain('update');
      expect(order).not.toContain('audit');
    });
  });
});
