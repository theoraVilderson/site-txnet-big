/**
 * A platform product is sellable by a reseller only if its package lists it
 * (ADR-0107 point 3, F-019-v5).
 *
 * What breaks without anyone seeing it:
 *  - **a reseller selling the platform's whole catalog.** A platform product
 *    its package does not list is not sold — not listed in the shop, not
 *    invoiced, not issued;
 *  - **a reseller with no package selling everything.** No subscription, no
 *    package: no platform product at all (user, 2026-10-01);
 *  - **the reseller's own catalog bounded.** Its own products are its own
 *    business: never filtered;
 *  - **the platform bounded by itself.** Its own tenant is not a reseller and
 *    sells every platform product.
 */
import { TenantType } from '@prisma/client';

import { offeredToTenant } from './offers';
import { platformProductsSoldBy, sellsProduct } from './package-products';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const PACKAGE = '33333333-3333-4333-8333-333333333333';
const LISTED = '44444444-4444-4444-8444-444444444444';
const UNLISTED = '55555555-5555-4555-8555-555555555555';

function fakeTx(opts: { tenantType?: TenantType; packageId?: string | null; listed?: string[] }) {
  const asked: Array<Record<string, unknown>> = [];
  const tx = {
    tenant: { findUnique: async () => ({ tenantType: opts.tenantType ?? TenantType.reseller }) },
    tenantSubscription: { findUnique: async () => (opts.packageId === null ? null : { packageId: opts.packageId ?? PACKAGE }) },
    packageProduct: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        asked.push(args.where);
        return (opts.listed ?? []).map((productId) => ({ productId }));
      },
    },
  };
  return { tx, asked };
}

describe('platformProductsSoldBy (F-019-v5)', () => {
  it("answers the products the reseller's package lists, read by its package", async () => {
    const { tx, asked } = fakeTx({ listed: [LISTED] });
    const listed = await platformProductsSoldBy(tx as never, RESELLER);
    expect(listed).toEqual(new Set([LISTED]));
    expect(asked).toEqual([{ packageId: PACKAGE }]);
  });

  it('answers nothing for a reseller with no subscription, without reading any list', async () => {
    const { tx, asked } = fakeTx({ packageId: null, listed: [LISTED] });
    expect(await platformProductsSoldBy(tx as never, RESELLER)).toEqual(new Set());
    expect(asked).toEqual([]);
  });

  it('bounds nothing for a tenant that is not a reseller', async () => {
    const { tx } = fakeTx({ tenantType: TenantType.platform_owner });
    expect(await platformProductsSoldBy(tx as never, RESELLER)).toBeNull();
  });
});

describe('sellsProduct (F-019-v5)', () => {
  const listed = new Set([LISTED]);

  it('sells a platform product only when the package lists it', () => {
    expect(sellsProduct(listed, { id: LISTED, tenantId: null })).toBe(true);
    expect(sellsProduct(listed, { id: UNLISTED, tenantId: null })).toBe(false);
    expect(sellsProduct(new Set(), { id: LISTED, tenantId: null })).toBe(false);
  });

  it("always sells the reseller's own product, and everything when nothing bounds the tenant", () => {
    expect(sellsProduct(new Set(), { id: UNLISTED, tenantId: RESELLER })).toBe(true);
    expect(sellsProduct(null, { id: UNLISTED, tenantId: null })).toBe(true);
  });
});

describe('offeredToTenant (F-019-v5)', () => {
  const at = new Date('2026-10-01T12:00:00Z');

  it("narrows the platform's rows to the listed products, and leaves the tenant's own alone", () => {
    const where = offeredToTenant(RESELLER, at, 'USD', new Set([LISTED]));
    expect(where.OR).toEqual([{ tenantId: RESELLER }, { tenantId: null, productId: { in: [LISTED] } }]);
  });

  it('is the shared-read rule unchanged when nothing bounds the tenant', () => {
    expect(offeredToTenant(RESELLER, at, 'USD').OR).toEqual([{ tenantId: RESELLER }, { tenantId: null }]);
  });
});
