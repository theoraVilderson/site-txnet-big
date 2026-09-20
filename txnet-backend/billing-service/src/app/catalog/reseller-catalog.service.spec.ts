/**
 * A named reseller's catalog (F-066-w7, ADR-0064): the same management as
 * `/api/catalog`, for the reseller the **path** names.
 *
 * There is one rule here, and everything else follows from it: the work runs
 * as the reseller. `ResellerAccess` (invariant 21) says whether this caller may
 * configure that reseller, opens the reseller's tenant scope, and only then is
 * `CatalogAdminService` called — with the reseller as its actor's tenant, so
 * every rule of the ambient surface applies unchanged rather than being
 * restated here. The ways that breaks are all silent:
 *
 *  - **the reseller comes from the path, never the body or the session.** The
 *    owner signs in to the *platform owner's* tenant, so a body's `tenantId`
 *    or the ambient `X-Tenant-Id` would file the product under the wrong
 *    tenant — or, for platform staff, under the platform itself, where every
 *    other reseller would then read it;
 *  - **the scope is open before the work.** Without it the app pool's RLS sees
 *    the caller's rows, so a list would answer the platform's products and a
 *    write would land in the caller's tenant;
 *  - **a refusal writes nothing.** `admit` throws before the work starts;
 *  - **nothing is elevated.** The actor handed on is a tenant, never the
 *    platform owner, so `CatalogAdminService.access` answers `owner: false`
 *    here for everyone — a platform item is not found, and a write of one is
 *    `not_platform_owner`, exactly as `catalog-admin.service.spec.ts` proves
 *    for a tenant.
 */
import { TenantType } from '@prisma/client';
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import type { CatalogActor } from './catalog-admin.service';
import { ResellerCatalogRefused, ResellerCatalogService } from './reseller-catalog.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const PRODUCT = '66666666-6666-4666-8666-666666666666';
const VARIANT = '77777777-7777-4777-8777-777777777777';
const PRICE = '88888888-8888-4888-8888-888888888888';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[], ip: '10.0.0.9' };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[], ip: '10.0.0.9' };

/** What the call saw: the actor `CatalogAdminService` was given, and the tenant in scope when it was. */
type Seen = { actor: CatalogActor; scope: string | undefined; args: unknown[] };

function build() {
  const seen: Seen[] = [];
  const record =
    (answer: unknown) =>
    async (actor: CatalogActor, ...args: unknown[]) => {
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

  const catalog = {
    listCategories: record([{ id: 'c' }]),
    createCategory: record({ id: 'c' }),
    updateCategory: record({ id: 'c' }),
    listProducts: record([{ id: PRODUCT }]),
    getProduct: record({ id: PRODUCT }),
    createProduct: record({ id: PRODUCT }),
    updateProduct: record({ id: PRODUCT }),
    createVariant: record({ id: VARIANT }),
    updateVariant: record({ id: VARIANT }),
    setPrice: record({ id: PRICE }),
    deactivatePrice: record({ id: PRICE }),
    listTextDrafts: record([]),
    draftMissingTexts: record({ drafted: 0 }),
    publishTextDrafts: record({ published: 0 }),
    editTexts: record({ published: 0 }),
  };

  return { seen, catalog, service: new ResellerCatalogService(new ResellerAccess(appPrisma as never), catalog as never) };
}

describe('a named reseller’s catalog', () => {
  it('runs every call as the reseller the path names, in that reseller’s scope', async () => {
    const { service, seen } = build();

    await service.listCategories(owner, RESELLER);
    await service.createCategory(owner, RESELLER, { key: 'vpn', name: { en: 'VPN' } });
    await service.updateCategory(owner, RESELLER, 'c', { isActive: false });
    await service.listProducts(owner, RESELLER, {});
    await service.getProduct(owner, RESELLER, PRODUCT);
    await service.updateProduct(owner, RESELLER, PRODUCT, { isActive: true });
    await service.createVariant(owner, RESELLER, PRODUCT, { sku: 'vpn-1m', billingMode: 'one_off', visibility: 'public', price: '5.00' } as never);
    await service.updateVariant(owner, RESELLER, VARIANT, { isActive: true });
    await service.setPrice(owner, RESELLER, VARIANT, { amount: '6.00' });
    await service.deactivatePrice(owner, RESELLER, PRICE);
    await service.listTextDrafts(owner, RESELLER, 'fa');
    await service.draftMissingTexts(owner, RESELLER);
    await service.publishTextDrafts(owner, RESELLER, { lang: 'fa', keys: ['k'] });
    await service.editTexts(owner, RESELLER, { lang: 'fa', texts: { k: 'v' } });

    expect(seen).toHaveLength(14);
    for (const call of seen) {
      // The reseller is the tenant of the work, and the caller only its author.
      expect(call.actor).toEqual({ adminId: OWNER_USER, tenantId: RESELLER, ip: '10.0.0.9' });
      // …and the app pool's RLS is bound to it before the first query.
      expect(call.scope).toBe(RESELLER);
    }
  });

  it('files a new item under the path’s reseller, whatever the body says', async () => {
    const { service, seen } = build();

    // A body naming another tenant — or the platform (`null`) — cannot move the
    // work: `tenantId` is the path's on this surface.
    await service.createCategory(owner, RESELLER, { key: 'vpn', name: { en: 'VPN' }, tenantId: OTHER } as never);
    await service.createProduct(owner, RESELLER, { categoryId: 'c', key: 'p', name: { en: 'P' }, fulfilmentKind: 'vpn_account', tenantId: null } as never);

    expect(seen[0].args[0]).toMatchObject({ tenantId: RESELLER });
    expect(seen[1].args[0]).toMatchObject({ tenantId: RESELLER });
  });

  it('keeps a product list to the reseller’s own, never the platform’s pick', async () => {
    const { service, seen } = build();
    // `tenantId` on the ambient query is the platform owner's filter. Here the
    // tenant is already decided, so a filter for it would be a second answer to
    // a question the path settled.
    await service.listProducts(owner, RESELLER, { categoryId: 'c', tenantId: 'platform' } as never);
    expect(seen[0].args[0]).toEqual({ categoryId: 'c' });
  });

  it('refuses a caller who may not configure that reseller, before any work', async () => {
    const { service, seen } = build();

    await expect(service.listCategories(stranger, RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });
    await expect(service.createProduct(stranger, RESELLER, { categoryId: 'c', key: 'p', name: { en: 'P' }, fulfilmentKind: 'vpn_account' } as never)).rejects.toMatchObject({
      reason: 'not_allowed',
    });
    // An unknown reseller is the same answer to anyone but platform staff.
    await expect(service.listCategories(owner, PRODUCT)).rejects.toMatchObject({ reason: 'not_allowed' });
    // This reseller's owner is not the other reseller's owner.
    await expect(service.listCategories(owner, OTHER)).rejects.toMatchObject({ reason: 'not_allowed' });

    expect(seen).toHaveLength(0);
  });

  it('names its refusals with one reason type, so every one gets a status', async () => {
    const { service } = build();
    const refusal = await service.listCategories(stranger, RESELLER).catch((e) => e);
    expect(refusal).toBeInstanceOf(ResellerCatalogRefused);
    expect(refusal.reason).toBe('not_allowed');
  });
});
