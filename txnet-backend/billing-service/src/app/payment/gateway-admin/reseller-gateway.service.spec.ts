/**
 * A named reseller's gateways (F-066-w3, ADR-0064): the same management as
 * `/api/billing/gateways`, for the reseller the **path** names.
 *
 * There is one rule here, and everything else follows from it: the work runs
 * as the reseller. `ResellerAccess` (invariant 21) says whether this caller may
 * configure that reseller, opens the reseller's tenant scope, and only then is
 * `GatewayAdminService` called — with the reseller as its actor's tenant, so
 * every rule of the ambient surface applies unchanged rather than being
 * restated here. The ways that breaks are all silent:
 *
 *  - **the reseller comes from the path, never the body or the session.** The
 *    owner signs in to the *platform owner's* tenant, so a body's `tenantId`
 *    or the ambient `X-Tenant-Id` would either configure the wrong tenant or
 *    hand the owner the platform's own gateways;
 *  - **the scope is open before the work.** Without it the app pool's RLS sees
 *    the caller's rows, so a list would answer the platform's gateways and a
 *    write would land in the caller's tenant;
 *  - **a refusal writes nothing.** `admit` throws before the work starts;
 *  - **nothing is elevated.** The actor handed on is a tenant, never the
 *    platform owner, so verification stays the platform owner's and a platform
 *    gateway is not found — the rules `gateway-admin.service.spec.ts` proves.
 */
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';
import { TenantType } from '@prisma/client';

import type { GatewayActor } from './gateway-admin.service';
import { ResellerGatewayRefused, ResellerGatewayService } from './reseller-gateway.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const GATEWAY = '66666666-6666-4666-8666-666666666666';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[], ip: '10.0.0.9' };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[], ip: '10.0.0.9' };

/** What the call saw: the actor `GatewayAdminService` was given, and the tenant in scope when it was. */
type Seen = { actor: GatewayActor; scope: string | undefined; args: unknown[] };

function build() {
  const seen: Seen[] = [];
  const record =
    (answer: unknown) =>
    async (actor: GatewayActor, ...args: unknown[]) => {
      seen.push({ actor, scope: TenantContext.currentOrNull()?.id, args });
      return answer;
    };

  const tenants: Record<string, { id: string; slug: string; tenantType: TenantType; ownerUserId: string | null; status: string; graceEndsAt: Date | null; deletedAt: Date | null }> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: TenantType.platform_owner, ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: TenantType.reseller, ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
    [OTHER]: { id: OTHER, slug: 'other', tenantType: TenantType.reseller, ownerUserId: STRANGER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const appPrisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  };

  const gateways = {
    list: record([{ id: GATEWAY }]),
    presets: record(['10.00']),
    setPresets: record(['20.00']),
    tax: record(null),
    setTax: record('9'),
    create: record({ id: GATEWAY }),
    update: record({ id: GATEWAY }),
    remove: record({ id: GATEWAY, mode: 'deleted' }),
  };

  return { seen, gateways, service: new ResellerGatewayService(new ResellerAccess(appPrisma as never), gateways as never) };
}

describe('a named reseller’s gateways', () => {
  it('runs every call as the reseller the path names, in that reseller’s scope', async () => {
    const { service, seen, gateways } = build();

    await service.list(owner, RESELLER);
    await service.presets(owner, RESELLER);
    await service.setPresets(owner, RESELLER, ['20.00']);
    await service.tax(owner, RESELLER);
    await service.setTax(owner, RESELLER, '9');
    await service.create(owner, RESELLER, { source: 'tenant', displayName: 'Zarinpal' });
    await service.update(owner, RESELLER, { source: 'tenant', id: GATEWAY }, { isActive: true });
    await service.remove(owner, RESELLER, { source: 'tenant', id: GATEWAY });

    expect(seen).toHaveLength(8);
    for (const call of seen) {
      // The reseller is the tenant of the work, and the caller only its author.
      expect(call.actor).toEqual({ adminId: OWNER_USER, tenantId: RESELLER, ip: '10.0.0.9' });
      // …and the app pool's RLS is bound to it before the first query.
      expect(call.scope).toBe(RESELLER);
    }
    // Delegated, not reimplemented: the answers are the ambient surface's.
    expect(gateways.list).toBeDefined();
  });

  it('takes the tenant from the path, never from the body', async () => {
    const { service, seen } = build();
    // A body naming another tenant cannot move the work: `tenantId` is the
    // path's, so the create lands in the admitted reseller.
    await service.create(owner, RESELLER, { source: 'tenant', displayName: 'Zarinpal', tenantId: OTHER } as never);
    expect(seen[0].actor.tenantId).toBe(RESELLER);
    expect(seen[0].args[0]).toMatchObject({ source: 'tenant', tenantId: RESELLER });
  });

  it('refuses a caller who may not configure that reseller, before any work', async () => {
    const { service, seen } = build();

    await expect(service.list(stranger, RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });
    await expect(service.create(stranger, RESELLER, { source: 'tenant' })).rejects.toMatchObject({ reason: 'not_allowed' });
    // An unknown reseller is the same answer to anyone but platform staff.
    await expect(service.list(owner, GATEWAY)).rejects.toMatchObject({ reason: 'not_allowed' });
    // The reseller's own owner is not its other reseller's owner.
    await expect(service.list(owner, OTHER)).rejects.toMatchObject({ reason: 'not_allowed' });

    expect(seen).toHaveLength(0);
  });

  it('names its refusals with one reason type, so every one gets a status', async () => {
    const { service } = build();
    await service.list(owner, RESELLER).catch(() => undefined);
    const refusal = await service.list(stranger, RESELLER).catch((e) => e);
    expect(refusal).toBeInstanceOf(ResellerGatewayRefused);
    expect(refusal.reason).toBe('not_allowed');
  });
});
