import { ForbiddenException } from '@nestjs/common';
import { ResellerAccessRefused } from '@txnet-backend/shared-core';

import { TenantContext, runWithTenant } from '../../tenant-context/tenant-context';

import { ResellerUserGroupsController } from './reseller-user-groups.controller';

/**
 * A reseller's groups by path (F-102-g-d): what its workspace's gateway editor
 * picks from. The ambient `/auth/user-groups` lists the session tenant's — the
 * platform's, for an owner on the platform panel (ADR-0064 (1)) — so the
 * reseller is the path's, behind invariant 21, and the list is read in its scope.
 */

const RESELLER = '22222222-2222-4222-8222-222222222222';
const req = { user: { sub: 'user-ali', tenantId: 'tenant-platform', permissions: [] }, ip: '10.0.0.1', headers: {} };

function build(admit: boolean) {
  const seenScope: unknown[] = [];
  const access = {
    for() {
      return this;
    },
    run: vi.fn(async (_actor: unknown, tenantId: string, _cap: string, work: (r: { id: string }) => Promise<unknown>) => {
      if (!admit) throw new ResellerAccessRefused('not_allowed', tenantId);
      return runWithTenant({ id: tenantId } as never, () => work({ id: tenantId }));
    }),
  };
  const groups = {
    list: vi.fn(async () => {
      seenScope.push(TenantContext.currentOrNull()?.id);
      return [{ id: 'g-1', name: 'vip' }];
    }),
  };
  return { controller: new ResellerUserGroupsController(access as never, groups as never), access, groups, seenScope };
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
});
