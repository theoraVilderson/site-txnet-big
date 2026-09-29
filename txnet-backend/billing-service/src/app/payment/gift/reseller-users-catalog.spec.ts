/**
 * The catalog the users pages name (F-311-ab1, D-57): what an admin issues and
 * what a bulk filter picks by product. Before this, those forms read the
 * catalog admin routes, so a support admin managing users needed
 * `catalog.manage` — the right to edit prices — to issue a service.
 *
 *  - **the users-admin door, not the catalog's**: `read` on the path's tenant,
 *    the platform's included for its staff; no `catalog.manage`;
 *  - **the tenant's own rows, named in the query** (C-15): catalog RLS is
 *    shared-read, so a reseller's scope also sees the platform's products; and
 *    the platform's own are `tenantId` null, not its tenant id;
 *  - archived products are left out; switched-off ones and their variants are
 *    listed with `isActive`, because a service sold before is still filtered by;
 *  - a refusal reads nothing.
 */
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STAFF_USER = '55555555-5555-4555-8555-555555555555';
const STRANGER = '66666666-6666-4666-8666-666666666666';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };
const staff = { userId: STAFF_USER, tenantId: PLATFORM, permissions: ['tenant.manage'] };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };

type Product = { id: string; tenantId: string | null; nameKey: string; isActive: boolean; archivedAt: Date | null; key: string };
const PRODUCTS: Product[] = [
  { id: 'p-plat', tenantId: null, nameKey: 'catalog.plat', isActive: true, archivedAt: null, key: 'a' },
  { id: 'p-res', tenantId: RESELLER, nameKey: 'catalog.res', isActive: true, archivedAt: null, key: 'b' },
  { id: 'p-res-off', tenantId: RESELLER, nameKey: 'catalog.off', isActive: false, archivedAt: null, key: 'c' },
  { id: 'p-res-gone', tenantId: RESELLER, nameKey: 'catalog.gone', isActive: true, archivedAt: new Date('2026-09-01'), key: 'd' },
];
const VARIANTS = [
  { id: 'v-plat', productId: 'p-plat', sku: 'PLAT-1', nameKey: null, isActive: true },
  { id: 'v-res', productId: 'p-res', sku: 'RES-1', nameKey: 'catalog.res.v1', isActive: true },
  { id: 'v-res-off', productId: 'p-res-off', sku: 'RES-2', nameKey: null, isActive: false },
  { id: 'v-gone', productId: 'p-res-gone', sku: 'RES-3', nameKey: null, isActive: true },
];

function build() {
  const reads: { where: unknown; scope: string | undefined }[] = [];
  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);
  // As catalog RLS answers: shared-read — the scope's rows and the platform's.
  const tx = {
    $executeRaw: async () => 1,
    product: {
      findMany: async ({ where }: { where: { tenantId: string | null; archivedAt: null } }) => {
        const scope = TenantContext.currentOrNull()?.id;
        reads.push({ where, scope });
        return PRODUCTS.filter((p) => (p.tenantId === null || p.tenantId === scope) && p.tenantId === where.tenantId && p.archivedAt === null)
          // Only what `select` names, as Prisma answers.
          .map((p) => ({
            id: p.id,
            nameKey: p.nameKey,
            isActive: p.isActive,
            variants: VARIANTS.filter((v) => v.productId === p.id).map(({ id, sku, nameKey, isActive }) => ({ id, sku, nameKey, isActive })),
          }));
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const service = new ResellerUserGrantsService(prisma as never, access, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { service, reads };
}

describe('the users pages catalog (F-311-ab1)', () => {
  it("lists a reseller's own products to its owner, holding no catalog permission — not the platform's, not an archived one", async () => {
    const { service, reads } = build();
    const products = await service.catalog(owner, RESELLER);
    expect(products).toEqual([
      { id: 'p-res', nameKey: 'catalog.res', isActive: true, variants: [{ id: 'v-res', sku: 'RES-1', nameKey: 'catalog.res.v1', isActive: true }] },
      { id: 'p-res-off', nameKey: 'catalog.off', isActive: false, variants: [{ id: 'v-res-off', sku: 'RES-2', nameKey: null, isActive: false }] },
    ]);
    expect(reads).toEqual([{ where: expect.objectContaining({ tenantId: RESELLER, archivedAt: null }), scope: RESELLER }]);
  });

  it("lists the platform's own products to its staff, as `tenantId` null", async () => {
    const { service } = build();
    const products = await service.catalog(staff, PLATFORM);
    expect(products.map((p) => p.id)).toEqual(['p-plat']);
    expect(products[0].variants.map((v) => v.id)).toEqual(['v-plat']);
  });

  it('refuses anyone the door refuses, and reads nothing', async () => {
    const { service, reads } = build();
    await expect(service.catalog(stranger, RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });
    await expect(service.catalog(owner, PLATFORM)).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    expect(reads).toEqual([]);
  });
});
