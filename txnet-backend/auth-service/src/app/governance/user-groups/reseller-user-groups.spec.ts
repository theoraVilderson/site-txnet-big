import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ResellerAccessRefused, ResellerLimitReached } from '@txnet-backend/shared-core';

import { TENANT_CEILING } from '@txnet-backend/shared-core';

import { TenantContext, runWithTenant } from '../../tenant-context/tenant-context';

import { ResellerUserGroupsController } from './reseller-user-groups.controller';
import { UserGroupRefused } from './user-group-admin.service';

/**
 * A reseller's groups by path (F-102-g-d): what its workspace's gateway editor
 * picks from. The ambient `/auth/user-groups` lists the session tenant's — the
 * platform's, for an owner on the platform panel (ADR-0064 (1)) — so the
 * reseller is the path's, behind invariant 21, and the list is read in its scope.
 */

const RESELLER = '22222222-2222-4222-8222-222222222222';
const req = { user: { sub: 'user-ali', tenantId: 'tenant-platform', permissions: [] }, ip: '10.0.0.1', headers: {} };

function build(admit: boolean, as: 'owner' | 'member' | 'staff' = 'owner') {
  const seenScope: unknown[] = [];
  const access = {
    for() {
      return this;
    },
    run: vi.fn(async (_actor: unknown, tenantId: string, _cap: string, work: (r: { id: string }) => Promise<unknown>) => {
      if (!admit) throw new ResellerAccessRefused('not_allowed', tenantId);
      return runWithTenant({ id: tenantId } as never, () => work({ id: tenantId, as } as never));
    }),
  };
  const scoped = (answer: unknown) =>
    vi.fn(async (..._args: unknown[]) => {
      seenScope.push(TenantContext.currentOrNull()?.id);
      return answer;
    });
  const groups = {
    list: scoped([{ id: 'g-1', name: 'vip' }]),
    create: scoped({ id: 'g-2', name: 'Support' }),
    addMembers: scoped({ added: 1 }),
    setMemberEnd: scoped({ userId: 'u-1', expiresAt: null }),
  };
  return { controller: new ResellerUserGroupsController(access as never, groups as never, {} as never), access, groups, seenScope };
}

describe('ResellerUserGroupsController', () => {
  it("lists the named reseller's groups, read in its scope, after the door admits", async () => {
    const h = build(true);

    await expect(h.controller.list(RESELLER, req as never)).resolves.toEqual([{ id: 'g-1', name: 'vip' }]);
    expect(h.access.run).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-ali' }), RESELLER, 'read', expect.any(Function));
    expect(h.seenScope).toEqual([RESELLER]);
  });

  it('answers the door\'s refusal as its status, and reads nothing', async () => {
    const h = build(false);

    await expect(h.controller.list(RESELLER, req as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.groups.list).not.toHaveBeenCalled();
  });

  // GR-1-d (ADR-0139 (5)): every group write is reachable by the reseller's path.
  describe('writes', () => {
    const GROUP = '33333333-3333-4333-8333-333333333333';

    it('opens the door for a write, and gives the service the owner as the owner — the whole tenant ceiling to give', async () => {
      const h = build(true, 'owner');

      await h.controller.create(RESELLER, { name: 'Support' }, req as never);

      expect(h.access.run).toHaveBeenCalledWith(expect.anything(), RESELLER, 'staffWrite', expect.any(Function));
      const actor = h.groups.create.mock.calls[0][0] as { adminId: string; as: string; permissions: string[] };
      expect(actor).toMatchObject({ adminId: 'user-ali', tenantId: RESELLER, as: 'owner' });
      expect(actor.permissions).toEqual(TENANT_CEILING);
      expect(actor.permissions.some((k) => k === '*' || k.startsWith('platform.'))).toBe(false);
      expect(h.seenScope).toEqual([RESELLER]);
    });

    it("gives the platform's staff only the part of the ceiling they hold", async () => {
      const h = build(true, 'staff');
      const staffReq = { ...req, user: { ...req.user, permissions: ['platform.tenant.manage', 'user.read'] } };

      await h.controller.addMembers(RESELLER, GROUP, { userIds: ['u-1'] }, staffReq as never);

      expect(h.groups.addMembers.mock.calls[0][0]).toMatchObject({ as: 'staff', permissions: ['user.read'] });
    });

    it("gives the reseller's own member their own keys, and passes a membership's end", async () => {
      const h = build(true, 'member');
      const memberReq = { ...req, user: { ...req.user, tenantId: RESELLER, permissions: ['user_group.manage', 'user.read'] } };
      const end = new Date('2026-11-01T00:00:00.000Z');

      await h.controller.addMembers(RESELLER, GROUP, { userIds: ['u-1'], expiresAt: end }, memberReq as never);
      await h.controller.setMemberEnd(RESELLER, GROUP, 'u-1', { expiresAt: null }, memberReq as never);

      expect(h.groups.addMembers).toHaveBeenCalledWith(expect.objectContaining({ as: 'member', permissions: ['user_group.manage', 'user.read'] }), GROUP, { userIds: ['u-1'], expiresAt: end });
      expect(h.groups.setMemberEnd).toHaveBeenCalledWith(expect.anything(), GROUP, 'u-1', null);
    });

    it("answers the service's refusals and the staff limit as the ambient path does", async () => {
      const h = build(true);
      h.groups.create.mockRejectedValueOnce(new UserGroupRefused('name_taken', 'Support'));
      h.groups.addMembers.mockRejectedValueOnce(new ResellerLimitReached('staff_members_max', 2, 2));

      await expect(h.controller.create(RESELLER, { name: 'Support' }, req as never)).rejects.toBeInstanceOf(ConflictException);
      const e = await h.controller.addMembers(RESELLER, GROUP, { userIds: ['u-1'] }, req as never).catch((x: ConflictException) => x);
      expect((e as ConflictException).getResponse()).toMatchObject({ reason: 'reseller_limit_reached', facts: { key: 'staff_members_max', limit: 2, used: 2 } });
    });
  });
});
