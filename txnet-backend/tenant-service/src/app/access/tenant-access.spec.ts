import { ResellerAccess } from '@txnet-backend/shared-core';

import { TenantAccessService } from './tenant-access.service';

/**
 * "May I administer this reseller?" as a question with an answer (F-311-e).
 *
 * The verdict is the door's own (`ResellerAccess`, tenant invariant 21), asked
 * here with the real rule behind a fake reader — a service that agreed with a
 * fake door would prove nothing. Three things are pinned:
 *
 * - **the same three doors, and no fourth**: the reseller's `ownerUserId` from
 *   whichever tenant their session is in, a live staff seat of it holding
 *   `tenant.manage`, the platform owner's staff with `tenant.manage`;
 * - **two verdicts, because the status matrix answers them differently**: a
 *   suspended reseller still reads and no longer writes, so one boolean would
 *   have to lie to one of the two;
 * - **it never refuses.** Asking whether you may is not doing it, so every
 *   caller gets a 200 and a boolean — and what only staff may learn (that a
 *   reseller exists at all) stays the door's answer, not this surface's.
 */
describe('TenantAccessService', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OTHER = '33333333-3333-3333-3333-333333333333';
  const UNKNOWN = '99999999-9999-9999-9999-999999999999';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';
  const CUSTOMER = '66666666-6666-6666-6666-666666666666';
  const T0 = new Date('2026-09-20T10:00:00Z');
  const LONG_AGO = new Date('2026-09-01T10:00:00Z');

  /** The owner's session is their own platform tenant's, on either domain (ADR-0059). */
  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'] };
  /** A user of the reseller itself — a customer, or a seat, depending on the seats built. */
  const insider = (permissions: string[] = []) => ({ userId: CUSTOMER, tenantId: RESELLER, permissions });

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
    return new TenantAccessService(new ResellerAccess(prisma as never));
  };

  it('answers the owner yes to both, from the tenant their session is actually in', async () => {
    await expect(build().verdict(owner, RESELLER, T0)).resolves.toEqual({
      tenantId: RESELLER,
      canRead: true,
      canWrite: true,
      reason: null,
    });
  });

  it('answers a live seat holding `tenant.manage` yes, and a seat without it no (F-018-j)', async () => {
    await expect(build('active', [seat()]).verdict(insider(['tenant.manage']), RESELLER, T0)).resolves.toMatchObject({
      canRead: true,
      canWrite: true,
    });
    // A seat is the membership; the permission is what administers. Neither alone.
    await expect(build('active', [seat()]).verdict(insider(), RESELLER, T0)).resolves.toEqual({
      tenantId: RESELLER,
      canRead: false,
      canWrite: false,
      reason: 'not_allowed',
    });
  });

  it('answers the platform owner’s staff yes, and a customer of the reseller no', async () => {
    await expect(build().verdict(staff, RESELLER, T0)).resolves.toMatchObject({ canRead: true, canWrite: true });
    // Being inside the reseller is not administering it, however wide the role.
    await expect(build().verdict(insider(['*', 'tenant.manage']), RESELLER, T0)).resolves.toMatchObject({
      canRead: false,
      reason: 'not_allowed',
    });
  });

  it('splits the two verdicts on a suspended reseller: it still reads, it no longer writes', async () => {
    await expect(build('suspended').verdict(owner, RESELLER, T0)).resolves.toEqual({
      tenantId: RESELLER,
      canRead: true,
      canWrite: false,
      // Nothing to explain: the panel opens, and what it may not do is simply
      // not offered. `reason` is why nobody may administer it at all.
      reason: null,
    });
    // Platform staff administer a suspended reseller, so their verdict does not split.
    await expect(build('suspended').verdict(staff, RESELLER, T0)).resolves.toMatchObject({ canRead: true, canWrite: true });
  });

  it('answers no to both on a terminated reseller, staff included', async () => {
    for (const actor of [owner, staff]) {
      await expect(build('terminated').verdict(actor, RESELLER, T0)).resolves.toEqual({
        tenantId: RESELLER,
        canRead: false,
        canWrite: false,
        reason: 'reseller_terminated',
      });
    }
  });

  it('tells only staff that a reseller exists — and refuses nobody', async () => {
    await expect(build().verdict(staff, UNKNOWN, T0)).resolves.toMatchObject({ reason: 'reseller_not_found' });
    // Everyone else gets the answer an id they may not administer gets.
    await expect(build().verdict(owner, UNKNOWN, T0)).resolves.toMatchObject({ reason: 'not_allowed' });
    await expect(build().verdict(owner, OTHER, T0)).resolves.toMatchObject({ reason: 'not_allowed' });
  });
});
