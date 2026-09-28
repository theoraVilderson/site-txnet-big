/**
 * An admin resets one user's `/sub` link (F-311-n, spec F-307): a new token for
 * a link that leaked, for a user of the reseller the **path** names.
 *
 * The rotation is the owner's own (`SubscriptionLinkService.reset`, F-114-e-b),
 * unchanged: host first, then `rotateToken`, one transaction, so the old link
 * stops exactly when the new one exists. What this surface adds, and each case
 * below is a way it breaks quietly:
 *
 *  - **it is asked as the path's user, in the reseller's scope.** The owner's
 *    ownership check (`grantId` + `userId`) is the only fence on the Grant, and
 *    the host is the tenant in scope's — the platform's would be a dead link;
 *  - **the door is `staffWrite`.** A suspended reseller still reads the link
 *    (F-311-f) but destroys none;
 *  - **the user must be the reseller's** (C-15), decided before anything rotates.
 */
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { ResellerUserGrantsService } from './reseller-user-grants.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const SUSPENDED = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const LATE_CUSTOMER = '77777777-7777-4777-8777-777777777777';
const GRANT = '88888888-8888-4888-8888-888888888888';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };

/** One call into `SubscriptionLinkService`: which, for whom, and the tenant in scope. */
type Called = { what: 'read' | 'reset'; grantId: string; userId: string; scope: string | undefined };

function build() {
  const called: Called[] = [];
  const scope = () => TenantContext.currentOrNull()?.id;

  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
    [SUSPENDED]: { id: SUSPENDED, slug: 'late', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'suspended', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);

  // Whose user each id is, found only in its own tenant's scope (RLS).
  const userTenant: Record<string, string> = { [CUSTOMER]: RESELLER, [LATE_CUSTOMER]: SUSPENDED };
  const tx = {
    $executeRaw: async () => 1,
    user: {
      findFirst: async ({ where }: { where: { id: string } }) => (userTenant[where.id] === scope() ? { id: where.id } : null),
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };

  const links = {
    linkFor: async (grantId: string, userId: string) => {
      called.push({ what: 'read', grantId, userId, scope: scope() });
      return 'https://sub.acme.example/sub/old';
    },
    reset: async (grantId: string, userId: string) => {
      called.push({ what: 'reset', grantId, userId, scope: scope() });
      return 'https://sub.acme.example/sub/new';
    },
  };

  const service = new ResellerUserGrantsService(prisma as never, access, {} as never, {} as never, {} as never, links as never, {} as never);
  return { called, service };
}

describe('ResellerUserGrantsService.rotateLink', () => {
  it('resets the link as the path\'s user, inside the reseller\'s scope, and answers the new one', async () => {
    const { called, service } = build();

    const url = await service.rotateLink(owner, RESELLER, CUSTOMER, GRANT);

    expect(url).toBe('https://sub.acme.example/sub/new');
    expect(called).toEqual([{ what: 'reset', grantId: GRANT, userId: CUSTOMER, scope: RESELLER }]);
  });

  it('refuses a suspended reseller as reseller_suspended and rotates nothing — though it still reads the link', async () => {
    const { called, service } = build();

    await expect(service.rotateLink(owner, SUSPENDED, LATE_CUSTOMER, GRANT)).rejects.toMatchObject({ reason: 'reseller_suspended' });
    expect(called).toEqual([]);

    await expect(service.subscriptionLink(owner, SUSPENDED, LATE_CUSTOMER, GRANT)).resolves.toBe('https://sub.acme.example/sub/old');
    expect(called.map((c) => c.what)).toEqual(['read']);
  });

  it('refuses a user of another tenant as user_not_found, before anything rotates', async () => {
    const { called, service } = build();

    await expect(service.rotateLink(owner, RESELLER, LATE_CUSTOMER, GRANT)).rejects.toMatchObject({ reason: 'user_not_found' });
    expect(called).toEqual([]);
  });
});
