/**
 * The panels an admin may move one of a user's configs to (F-311-v1, spec
 * F-311): the read behind the panel sheet's "move", over the rule
 * `ConfigActionsService.move` already holds — a panel shared (`tenantId`
 * null) or the reseller's own, not retired.
 *
 *  - **`network.panel` has no RLS**, so the reseller's scope hides nothing:
 *    the path's tenant is the filter, written into the query, or a reseller
 *    would list another reseller's dedicated panels;
 *  - **offered is narrower than accepted**: a panel not yet accepted by review
 *    is left out — a move there lands on a panel nothing provisions;
 *  - **no address, no credential**: the row is id, name, region and whether it
 *    is the reseller's own — never `apiBaseUrl`, `ipAddress` or the secrets;
 *  - **the door and the user fence first**, as every read of this surface.
 */
import { ResellerAccess } from '@txnet-backend/shared-core';

import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };

type Where = { retiredAt: null; reviewState: { in: string[] }; OR: { tenantId: string | null }[] };

function build() {
  const asked: { where: Where; select: Record<string, boolean> }[] = [];
  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
    [OTHER]: { id: OTHER, slug: 'other', tenantType: 'reseller', ownerUserId: STRANGER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);

  // Every panel there is; the fake applies the query's own filter, so the
  // answer is only as narrow as the where clause the service wrote.
  const panels = [
    { id: 'shared', name: 'DE-1', region: 'de', tenantId: null, retiredAt: null, reviewState: 'accepted', apiBaseUrl: 'https://x' },
    { id: 'own', name: 'Acme-1', region: 'nl', tenantId: RESELLER, retiredAt: null, reviewState: 'accepted_low_trust' },
    { id: 'foreign', name: 'Other-1', region: 'fi', tenantId: OTHER, retiredAt: null, reviewState: 'accepted' },
    { id: 'retired', name: 'Old', region: 'de', tenantId: null, retiredAt: new Date(), reviewState: 'accepted' },
    { id: 'pending', name: 'New', region: 'de', tenantId: RESELLER, retiredAt: null, reviewState: 'pending' },
  ];
  const tx = {
    $executeRaw: async () => 1,
    user: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === CUSTOMER ? { id: CUSTOMER } : null) },
    panel: {
      findMany: async (args: { where: Where; select: Record<string, boolean> }) => {
        asked.push(args);
        const { where, select } = args;
        return panels
          .filter((p) => p.retiredAt === where.retiredAt && where.reviewState.in.includes(p.reviewState))
          .filter((p) => where.OR.some((o) => o.tenantId === p.tenantId))
          .map((p) => Object.fromEntries(Object.keys(select).map((k) => [k, (p as Record<string, unknown>)[k]])));
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx), ...tx };
  const service = new ResellerUserGrantsService(prisma as never, access, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { asked, service };
}

describe('ResellerUserGrantsService.moveTargets', () => {
  it('lists the shared panels and the reseller\'s own, accepted and not retired', async () => {
    const { service } = build();
    const panels = await service.moveTargets(owner, RESELLER, CUSTOMER);
    expect(panels).toEqual([
      { id: 'shared', name: 'DE-1', region: 'de', own: false },
      { id: 'own', name: 'Acme-1', region: 'nl', own: true },
    ]);
  });

  it('filters by the path\'s tenant in the query itself, and selects no address or secret', async () => {
    const { asked, service } = build();
    await service.moveTargets(owner, RESELLER, CUSTOMER);
    expect(asked).toHaveLength(1);
    expect(asked[0].where.OR).toEqual([{ tenantId: null }, { tenantId: RESELLER }]);
    expect(Object.keys(asked[0].select).sort()).toEqual(['id', 'name', 'region', 'tenantId']);
  });

  it('reads no panel for a caller the door refuses, or for a user not the reseller\'s', async () => {
    const { asked, service } = build();
    await expect(service.moveTargets(stranger, RESELLER, CUSTOMER)).rejects.toMatchObject({ reason: 'not_allowed' });
    await expect(service.moveTargets(owner, RESELLER, STRANGER)).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    expect(asked).toHaveLength(0);
  });
});
