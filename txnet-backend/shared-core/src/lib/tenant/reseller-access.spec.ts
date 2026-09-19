import { TenantContext } from '../tenant-context/tenant-context';
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
 *   holding `tenant.manage` in that tenant — they need a live staff seat
 *   (F-018-j), which is the third door and the only one the reseller itself
 *   opens;
 * - what the owner may do is the **reseller's** status matrix (rules.md), not
 *   their own tenant's, which `TenantStatusGuard` judges and is always active;
 * - admitted work runs in the **reseller's** scope, never the caller's
 *   (ADR-0064 (3)), and refused work does not run at all.
 *
 * Lives in `shared-core` since F-066-w1 (ADR-0064 (2)): every service's
 * `/tenants/:tenantId/...` route calls this one rule.
 */
describe('ResellerAccess', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OTHER = '33333333-3333-3333-3333-333333333333';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';
  const CUSTOMER = '66666666-6666-6666-6666-666666666666';
  const T0 = new Date('2026-09-18T10:00:00Z');
  const LONG_AGO = new Date('2026-09-01T10:00:00Z');

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'] };

  /** A member of the reseller: their session is the reseller's, unlike the owner's. */
  type Seat = { tenantId: string; userId: string; joinedAt: Date | null; accessExpiresAt: Date | null; revokedAt: Date | null };
  const seat = (over: Partial<Seat> = {}): Seat => ({
    tenantId: RESELLER,
    userId: CUSTOMER,
    joinedAt: LONG_AGO,
    accessExpiresAt: null,
    revokedAt: null,
    ...over,
  });

  const build = (status = 'active', seats: Seat[] = []) => {
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
      tenantStaffMember: {
        findFirst: vi.fn(async ({ where }: { where: { tenantId: string; userId: string } }) =>
          seats.find((s) => s.tenantId === where.tenantId && s.userId === where.userId && s.revokedAt === null && s.joinedAt !== null) ?? null,
        ),
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

  it('admits a live staff seat with `tenant.manage`, and nothing less (F-018-j)', async () => {
    const member = { userId: CUSTOMER, tenantId: RESELLER, permissions: ['tenant.manage'] };
    await expect(build('active', [seat()]).admit(member, RESELLER, 'staffWrite', T0)).resolves.toEqual({
      id: RESELLER,
      slug: 'ali',
      as: 'member',
    });

    // The seat is the membership; the permission is what administers. Neither alone.
    const noPermission = { ...member, permissions: ['user.read'] };
    await expect(build('active', [seat()]).admit(noPermission, RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });

    // Invited and not yet accepted, expired, and removed: three seats that admit nobody.
    for (const dead of [seat({ joinedAt: null }), seat({ accessExpiresAt: LONG_AGO }), seat({ revokedAt: LONG_AGO })]) {
      await expect(build('active', [dead]).admit(member, RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'not_allowed' });
    }

    // A seat on one reseller is not a seat on another.
    await expect(build('active', [seat()]).admit({ ...member, tenantId: OTHER }, OTHER, 'read', T0)).rejects.toMatchObject({
      reason: 'not_allowed',
    });

    // And a member is held to their reseller's matrix, as the owner is.
    await expect(build('suspended', [seat()]).admit(member, RESELLER, 'read', T0)).resolves.toMatchObject({ as: 'member' });
    await expect(build('suspended', [seat()]).admit(member, RESELLER, 'staffWrite', T0)).rejects.toMatchObject({ reason: 'reseller_suspended' });
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

  it("runs admitted work in the reseller's scope, and refused work not at all (ADR-0064 (3))", async () => {
    const access = build('suspended');
    const seen = await access.run(owner, RESELLER, 'read', async (reseller) => ({ reseller, scope: TenantContext.current().id }), T0);
    // The owner's session is the platform's; the work is the reseller's.
    expect(seen).toEqual({ reseller: { id: RESELLER, slug: 'ali', as: 'owner' }, scope: RESELLER });

    const work = vi.fn();
    await expect(access.run(owner, RESELLER, 'staffWrite', work, T0)).rejects.toMatchObject({ reason: 'reseller_suspended' });
    await expect(access.run(owner, OTHER, 'read', work, T0)).rejects.toMatchObject({ reason: 'not_allowed' });
    expect(work).not.toHaveBeenCalled();
  });
});
