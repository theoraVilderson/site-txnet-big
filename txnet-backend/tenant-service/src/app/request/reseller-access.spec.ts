import { ResellerAccess } from './reseller-access';

/**
 * The invariant F-061-h turns on (ADR-0059 (1), tenant invariant 21).
 *
 * A reseller self-service route names the reseller in its path, and the caller
 * reaches it as that reseller's `ownerUserId` or as the platform owner's staff
 * holding `tenant.manage` — **never through the ambient tenant**. On the
 * owner's own domain the ambient tenant is their platform account's, so:
 *
 * - the owner is admitted from either domain with the same session;
 * - a user of the reseller's own tenant is not its owner by being there, even
 *   holding `tenant.manage` in that tenant;
 * - what the owner may do is the **reseller's** status matrix (rules.md), not
 *   their own tenant's, which `TenantStatusGuard` judges and is always active.
 */
describe('ResellerAccess', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OTHER = '33333333-3333-3333-3333-333333333333';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';
  const CUSTOMER = '66666666-6666-6666-6666-666666666666';
  const T0 = new Date('2026-09-18T10:00:00Z');

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'] };

  const build = (status = 'active') => {
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform_owner', ownerUserId: STAFF, status: 'active' },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status, graceEndsAt: null },
      [OTHER]: { id: OTHER, tenantType: 'reseller', slug: 'reza', ownerUserId: STAFF, status: 'active', graceEndsAt: null },
    };
    const prisma = {
      tenant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
      },
    };
    return new ResellerAccess(prisma as never);
  };

  it('admits the owner by the path, whatever tenant their session is in', async () => {
    const access = build();
    await expect(access.admit(owner, RESELLER, 'staffWrite', T0)).resolves.toEqual({ id: RESELLER, slug: 'ali', as: 'owner' });
    // The same person, reaching the reseller they do not own.
    await expect(access.admit(owner, OTHER, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });
  });

  it('never admits by the ambient tenant: being in the reseller is not owning it', async () => {
    const access = build();
    const insider = { userId: CUSTOMER, tenantId: RESELLER, permissions: ['*', 'tenant.manage'] };
    await expect(access.admit(insider, RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });
  });

  it('admits platform staff, and tells only them that a reseller does not exist', async () => {
    const access = build();
    const unknown = '99999999-9999-9999-9999-999999999999';
    await expect(access.admit(staff, RESELLER, 'staffWrite', T0)).resolves.toMatchObject({ as: 'staff' });
    await expect(access.admit(staff, unknown, 'read', T0)).rejects.toMatchObject({ reason: 'reseller_not_found' });
    await expect(access.admit(owner, unknown, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });
    await expect(access.admit(owner, PLATFORM, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });
  });

  it("judges the owner by the reseller's status, not their own tenant's", async () => {
    const access = build('suspended');
    await expect(access.admit(owner, RESELLER, 'read', T0)).resolves.toMatchObject({ as: 'owner' });
    await expect(access.admit(owner, RESELLER, 'staffWrite', T0)).rejects.toMatchObject({ reason: 'reseller_suspended' });
    // The platform owner's staff administer a suspended reseller; the matrix is the reseller panel's.
    await expect(access.admit(staff, RESELLER, 'staffWrite', T0)).resolves.toMatchObject({ as: 'staff' });
  });

  it('refuses everyone on a terminated reseller', async () => {
    const access = build('terminated');
    await expect(access.admit(owner, RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'reseller_terminated' });
    await expect(access.admit(staff, RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'reseller_terminated' });
  });
});
