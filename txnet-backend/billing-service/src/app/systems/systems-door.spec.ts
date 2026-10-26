/**
 * The systems surface's two doors (BYO-1-b, ADR-0166): the owner's at
 * `/billing/systems` on `platform.node.manage`, and a reseller's at
 * `/billing/tenants/:tenantId/systems` through `ResellerAccess` on
 * `node.manage`. What breaks quietly:
 *
 *  - **the wrong tenant.** Behind the reseller's door the actor is the path's
 *    tenant, never the session's — the reseller's owner signs in on the
 *    platform's tenant (ADR-0059), so the session's would be the platform's
 *    panels;
 *  - **a door that admits by the wrong rule.** A look is `read`, a change
 *    `staffWrite`; a refusal is the reseller routes' 403/404, never a pass;
 *  - **a scope that leaks.** A reseller's scope is its own panels; the
 *    platform's tenant keeps the platform's; anyone else is refused;
 *  - **a read RLS hides.** `network.panel` is tenant-isolated: a reseller's
 *    panel read on the app pool, outside its tenant's transaction, is not
 *    there. Reads go through the cross-tenant pool with the scope in `where`.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantType } from '@prisma/client';
import { ResellerAccessRefused } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { panelScopeOf } from './panel-scope';
import { SystemsDoorGuard, systemsActorOf } from './systems-door';
import { SystemsReadService } from './systems-read';

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';

type Admitted = { tenantId: string; capability: string; keys: string[]; staff: string[] };

function door(refuse?: 'not_allowed' | 'reseller_not_found') {
  const admitted: Admitted[] = [];
  const make = (keys: string[], staff: string[]) => ({
    for: (...k: string[]) => make(k, staff),
    asStaff: (...s: string[]) => make(keys, s),
    admit: async (_actor: unknown, tenantId: string, capability: string) => {
      if (refuse) throw new ResellerAccessRefused(refuse, tenantId);
      admitted.push({ tenantId, capability, keys, staff });
      return { id: tenantId, slug: 'chill', as: 'owner' };
    },
  });
  return { access: make([], []), admitted };
}

function request(opts: { method?: string; tenantId?: string; permissions?: string[] }): Request {
  return {
    method: opts.method ?? 'GET',
    params: opts.tenantId ? { tenantId: opts.tenantId } : {},
    headers: {},
    identity: { userId: USER, tenantId: OWNER_TENANT, permissions: opts.permissions ?? [] },
  } as unknown as Request;
}

const context = (req: Request) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;

describe('SystemsDoorGuard (BYO-1-b)', () => {
  it("the owner's door asks platform.node.manage, and the actor is the session's tenant", async () => {
    const { access, admitted } = door();
    const guard = new SystemsDoorGuard(access as never);

    const req = request({ permissions: ['platform.node.manage'] });
    await expect(guard.canActivate(context(req))).resolves.toBe(true);
    expect(systemsActorOf(req)).toEqual({ adminId: USER, tenantId: OWNER_TENANT });
    await expect(guard.canActivate(context(request({ permissions: ['node.manage'] })))).rejects.toBeInstanceOf(ForbiddenException);
    expect(admitted).toEqual([]);
  });

  it("a reseller's door admits on node.manage — read to look, staffWrite to change — and the actor is the path's tenant", async () => {
    const { access, admitted } = door();
    const guard = new SystemsDoorGuard(access as never);

    const look = request({ tenantId: RESELLER });
    await guard.canActivate(context(look));
    const change = request({ method: 'POST', tenantId: RESELLER });
    await guard.canActivate(context(change));

    expect(admitted).toEqual([
      { tenantId: RESELLER, capability: 'read', keys: ['node.manage'], staff: ['platform.node.manage'] },
      { tenantId: RESELLER, capability: 'staffWrite', keys: ['node.manage'], staff: ['platform.node.manage'] },
    ]);
    expect(systemsActorOf(change)).toEqual({ adminId: USER, tenantId: RESELLER });
  });

  it("a refusal is the reseller routes' status, and an unadmitted path names no actor", async () => {
    const refused = new SystemsDoorGuard(door('not_allowed').access as never);
    const req = request({ method: 'POST', tenantId: RESELLER });
    await expect(refused.canActivate(context(req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(() => systemsActorOf(req)).toThrow();
    await expect(new SystemsDoorGuard(door('reseller_not_found').access as never).canActivate(context(request({ tenantId: RESELLER })))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('panelScopeOf (ADR-0166 point 2)', () => {
  const prisma = (type: TenantType | null) => ({ tenant: { findUnique: async () => (type ? { tenantType: type } : null) } });

  it("is the platform's panels for the platform, a reseller's own for a reseller, and refused for no tenant", async () => {
    await expect(panelScopeOf(prisma(TenantType.platform_owner) as never, { adminId: USER, tenantId: OWNER_TENANT })).resolves.toEqual({
      ownershipType: 'platform',
      tenantId: null,
    });
    await expect(panelScopeOf(prisma(TenantType.reseller) as never, { adminId: USER, tenantId: RESELLER })).resolves.toEqual({
      ownershipType: 'tenant',
      tenantId: RESELLER,
    });
    await expect(panelScopeOf(prisma(null) as never, { adminId: USER, tenantId: RESELLER })).rejects.toMatchObject({ reason: 'not_platform_owner' });
  });
});

describe("SystemsReadService.panels for a reseller (BYO-1-b)", () => {
  it('reads its panels on the cross-tenant pool, the scope in the where', async () => {
    const asked: unknown[] = [];
    const rows = { panel: { findMany: async ({ where }: { where: unknown }) => (asked.push(where), []) } };
    const prisma = {
      tenant: { findUnique: async () => ({ tenantType: TenantType.reseller }) },
      panel: { findMany: async () => { throw new Error('the app pool hides a reseller panel'); } },
    };
    const all = {
      ...rows,
      panelDriftEvent: { findMany: async () => [] },
      collectorHeartbeat: { findFirst: async () => null },
      panelCost: { findMany: async () => [] },
    };

    await expect(new SystemsReadService(prisma as never, all as never).panels({ adminId: USER, tenantId: RESELLER })).resolves.toEqual([]);
    expect(asked).toEqual([{ ownershipType: 'tenant', tenantId: RESELLER }]);
  });
});
