/**
 * Who among a tenant's users may buy a product (PT-1-b, ADR-0142 (4)): every
 * user when the product names no group, else only a live user member of one.
 *
 * What would break silently here, and nowhere else:
 *  - the shop lists, and a direct link sells, a product to a user its owner
 *    meant to keep it from — the list and the invoice read are two doors, and
 *    both are asked (`listOffersIn`, `sellableOfferById`);
 *  - an admin hands it out by hand to someone outside the group
 *    (`issueGrantByAdmin`, `not_in_audience`);
 *  - a platform product a reseller sells is filtered by the platform's
 *    groups, which hold the platform's users, not the reseller's — the
 *    package list is the lever there (F-019-v5);
 *  - a product with no audience costs a read of nothing but its own rows.
 */
import { FulfilmentKind, Prisma, VariantVisibility } from '@prisma/client';
import { productsClosedTo, runWithTenant } from '@txnet-backend/shared-core';

import { issueGrantByAdmin } from '../entitlement/admin-issue';
import { EntitlementRefused, type GrantService } from '../entitlement/grant';
import { listOffersIn, sellableOfferById } from './catalog-reads';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PLATFORM = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const VARIANT = '66666666-6666-4666-8666-666666666666';
const GROUP = '77777777-7777-4777-8777-777777777777';
const OTHER_GROUP = '88888888-8888-4888-8888-888888888888';
const AT = new Date('2026-10-13T12:00:00Z');

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);

function variantRow(productTenant = TENANT) {
  return {
    id: VARIANT,
    sku: 'VIP-30',
    tenantId: productTenant,
    nameKey: null,
    visibility: VariantVisibility.public,
    isActive: true,
    quotas: {},
    durationDays: 30,
    billingMode: 'prepaid',
    qualityTier: 'standard',
    panelGroupId: null,
    product: {
      id: PRODUCT,
      tenantId: productTenant,
      key: 'vip',
      nameKey: 'catalog.product.vip.name',
      descriptionKey: null,
      fulfilmentKind: FulfilmentKind.feature_access,
      featureKeys: [],
      isActive: true,
      categories: [{ position: 0, category: { key: 'vip', nameKey: 'catalog.category.vip.name', isActive: true, parentId: null } }],
    },
    prices: [{ id: 'price-1', amount: new Prisma.Decimal('9.00'), currencyCode: 'USD', effectiveFrom: new Date('2026-01-01T00:00:00Z'), isActive: true }],
    rateCards: [],
  };
}

type Setup = { audience?: string[]; productTenant?: string; members?: Record<string, string[]> };

/** A transaction as the readers see it: one variant, its product's audience rows, and who is in which group. */
function build(setup: Setup = {}) {
  const reads = { audience: 0, members: 0 };
  const audience = (setup.audience ?? []).map((groupId) => ({ productId: PRODUCT, groupId }));
  const members = setup.members ?? { [MEMBER]: [GROUP] };
  const tx = {
    // The caller is the product's own tenant unless a test says otherwise; it is not a reseller, so no package bounds it.
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD', tenantType: 'platform_owner' }) },
    productVariant: {
      findMany: async () => [variantRow(setup.productTenant)],
      findUnique: async () => variantRow(setup.productTenant),
    },
    productAudience: {
      findMany: async ({ where }: { where: { productId: { in: string[] } } }) => {
        reads.audience += 1;
        return audience.filter((a) => where.productId.in.includes(a.productId));
      },
    },
    userGroupMember: {
      findMany: async ({ where }: { where: { userId: string } }) => {
        reads.members += 1;
        return (members[where.userId] ?? []).map((groupId) => ({ groupId }));
      },
    },
    grant: { findFirst: async () => null },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, reads };
}

const grants = {
  issue: async () => ({
    grant: { id: 'grant-1', tenantId: TENANT, variantId: VARIANT, status: 'active', startsAt: AT, endsAt: null },
    token: 'token',
  }),
} as unknown as GrantService;

const adminIssue = (userId: string) => ({ userId, variantId: VARIANT, requestId: `req-${userId}`, actorUserId: 'admin-1', at: AT });

describe('product audience (PT-1-b)', () => {
  it('a product with no audience is offered to everyone, and no membership is read', async () => {
    const { tx, reads } = build();
    const offers = await asTenant(() => listOffersIn(tx, AT, OUTSIDER));
    expect(offers.map((o) => o.variantId)).toEqual([VARIANT]);
    expect(reads.members).toBe(0);
  });

  it('the shop lists a product with an audience to a member of one of its groups, and to no one else', async () => {
    const { tx } = build({ audience: [OTHER_GROUP, GROUP] });
    await expect(asTenant(() => listOffersIn(tx, AT, MEMBER))).resolves.toHaveLength(1);
    await expect(asTenant(() => listOffersIn(tx, AT, OUTSIDER))).resolves.toEqual([]);
  });

  it('a direct link (the invoice read) sells it to a member and to no one else', async () => {
    const { tx } = build({ audience: [GROUP] });
    await expect(asTenant(() => sellableOfferById(tx, VARIANT, AT, MEMBER))).resolves.toMatchObject({ variantId: VARIANT });
    await expect(asTenant(() => sellableOfferById(tx, VARIANT, AT, OUTSIDER))).resolves.toBeNull();
  });

  it("a platform product sold in a reseller's tenant is not filtered by the platform's groups", async () => {
    const { tx, reads } = build({ audience: [GROUP], productTenant: PLATFORM });
    const closed = await productsClosedTo(tx, TENANT, OUTSIDER, [{ id: PRODUCT, tenantId: PLATFORM }]);
    expect(closed.size).toBe(0);
    expect(reads.audience).toBe(0);
  });

  it('an admin issue to a user outside the audience is refused, and to a member it issues', async () => {
    const { tx } = build({ audience: [GROUP] });
    await expect(asTenant(() => issueGrantByAdmin(tx, grants, adminIssue(OUTSIDER)))).rejects.toMatchObject({
      constructor: EntitlementRefused,
      reason: 'not_in_audience',
    });
    await expect(asTenant(() => issueGrantByAdmin(tx, grants, adminIssue(MEMBER)))).resolves.toMatchObject({ grantId: 'grant-1', issued: true });
  });
});
