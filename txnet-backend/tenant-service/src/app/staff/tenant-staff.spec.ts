import { ResellerAccess, ResellerLimitReached } from '@txnet-backend/shared-core';
import { inviteStaffSchema } from './tenant-staff.schema';
import { StaffRefused, TenantStaffService } from './tenant-staff.service';

/**
 * The invariant F-018-j turns on (catalog F-1201, D-42 (2)).
 *
 * - `tenant_staff_member` holds **membership only**: invited, accepted, until
 *   when, removed. What a member may do is their `identity.user.roleId`, a role
 *   of that tenant (F-018-n) — there is no second ladder to keep in step.
 * - A seat is granted to a user **of that reseller's tenant**. The owner is not
 *   one of them: they are the platform's customer (ADR-0059), and giving them a
 *   seat would be the account move ADR-0062 left open.
 * - A seat is what admits a member to reseller self-service, and only while it
 *   is accepted, unexpired and unrevoked — {@link ResellerAccess}, invariant 21.
 * - Removing keeps the row (`revokedAt`), and re-inviting reuses it, so one
 *   person is one row per reseller whatever their history.
 */
describe('TenantStaffService', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';
  const MEMBER = '66666666-6666-6666-6666-666666666666';
  const OUTSIDER = '77777777-7777-7777-7777-777777777777';
  const SUPPORT_ROLE = '88888888-8888-8888-8888-888888888888';
  const SECOND = '99999999-9999-4999-8999-999999999991';
  const THIRD = '99999999-9999-4999-8999-999999999992';
  const T0 = new Date('2026-09-19T10:00:00Z');
  const LATER = new Date('2026-10-19T10:00:00Z');

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const platformStaff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'] };
  const member = { userId: MEMBER, tenantId: RESELLER, permissions: ['tenant.manage'] };

  type Row = {
    id: string;
    tenantId: string;
    userId: string;
    invitedByUserId: string | null;
    invitedAt: Date;
    joinedAt: Date | null;
    accessExpiresAt: Date | null;
    revokedAt: Date | null;
  };

  const build = (opts: { status?: string; rows?: Partial<Row>[]; staffLimit?: number | null } = {}) => {
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform_owner', ownerUserId: STAFF, status: 'active' },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status: opts.status ?? 'active', graceEndsAt: null },
    };
    const users: Record<string, Record<string, unknown>> = {
      [MEMBER]: { id: MEMBER, tenantId: RESELLER, fullName: 'Sara', username: 'sara', phoneNumber: '+989120000001', status: 'active', deletedAt: null, roleId: SUPPORT_ROLE, role: { id: SUPPORT_ROLE, name: 'Support' } },
      [OUTSIDER]: { id: OUTSIDER, tenantId: PLATFORM, fullName: 'Reza', username: 'reza', phoneNumber: null, status: 'active', deletedAt: null, roleId: SUPPORT_ROLE, role: { id: SUPPORT_ROLE, name: 'Support' } },
      [SECOND]: { id: SECOND, tenantId: RESELLER, fullName: 'Nima', username: 'nima', phoneNumber: null, status: 'active', deletedAt: null, roleId: SUPPORT_ROLE, role: { id: SUPPORT_ROLE, name: 'Support' } },
      [THIRD]: { id: THIRD, tenantId: RESELLER, fullName: 'Mina', username: 'mina', phoneNumber: null, status: 'active', deletedAt: null, roleId: SUPPORT_ROLE, role: { id: SUPPORT_ROLE, name: 'Support' } },
      [OWNER]: { id: OWNER, tenantId: PLATFORM, fullName: 'Ali', username: 'ali', phoneNumber: null, status: 'active', deletedAt: null, roleId: SUPPORT_ROLE, role: { id: SUPPORT_ROLE, name: 'Support' } },
    };

    let seq = 0;
    const rows: Row[] = (opts.rows ?? []).map((r) => ({
      id: `row-${++seq}`,
      tenantId: RESELLER,
      userId: MEMBER,
      invitedByUserId: OWNER,
      invitedAt: T0,
      joinedAt: null,
      accessExpiresAt: null,
      revokedAt: null,
      ...r,
    }));

    const match = (row: Row, where: Record<string, any>): boolean =>
      Object.entries(where).every(([k, v]) => {
        if (v === null || v instanceof Date || typeof v !== 'object') return (row as any)[k] === v;
        if ('not' in v) return (row as any)[k] !== v.not;
        return true;
      });

    const staffMember = {
      // The seats that count against `staff_members_max`: not removed, not expired.
      count: vi.fn(async ({ where }: { where: { tenantId: string; revokedAt: null; OR: Array<{ accessExpiresAt: null | { gt: Date } }> } }) => {
        const gt = (where.OR.find((o) => o.accessExpiresAt !== null)?.accessExpiresAt as { gt: Date }).gt;
        return rows.filter((r) => r.tenantId === where.tenantId && !r.revokedAt && (!r.accessExpiresAt || r.accessExpiresAt > gt)).length;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => rows.find((r) => match(r, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => rows.filter((r) => match(r, where))),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const row: Row = { id: `row-${++seq}`, invitedAt: T0, joinedAt: null, accessExpiresAt: null, revokedAt: null, invitedByUserId: null, ...(data as any) };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('no such row');
        Object.assign(row, data);
        return row;
      }),
    };

    const appPrisma = {
      tenant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
      },
      tenantStaffMember: staffMember,
    };
    const limitRows = opts.staffLimit === undefined ? [] : [{ key: 'staff_members_max', value: opts.staffLimit }];
    const all: Record<string, unknown> = {
      tenantStaffMember: staffMember,
      tenant: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null) },
      tenantSubscription: { findUnique: vi.fn(async () => null) },
      resellerLimit: { findMany: vi.fn(async () => limitRows) },
      packageLimit: { findMany: vi.fn(async () => []) },
      resellerLimitSetting: { findMany: vi.fn(async () => []) },
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(all)),
      user: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => {
          const row = users[where.id];
          if (!row) return null;
          if (where.tenantId && row.tenantId !== where.tenantId) return null;
          return row;
        }),
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => users[id]).filter(Boolean)),
      },
    };

    const access = new ResellerAccess(appPrisma as never);
    // The app pool is the invitee's own tenant (accept); the cross-tenant pool
    // is every other read, which is another tenant's rows.
    return { service: new TenantStaffService(appPrisma as never, all as never, access), rows, all, staffMember };
  };

  it('seats a user of the reseller, and only the owner or platform staff may', async () => {
    const { service, rows } = build();
    const view = await service.invite(owner, RESELLER, { userId: MEMBER }, T0);
    expect(view).toMatchObject({ userId: MEMBER, state: 'invited', joinedAt: null, accessExpiresAt: null });
    expect(view.role).toEqual({ id: SUPPORT_ROLE, name: 'Support' });
    expect(rows).toHaveLength(1);
    expect(rows[0].invitedByUserId).toBe(OWNER);

    // A user of another tenant is not seatable here, and is not told the reseller's roster either.
    await expect(service.invite(owner, RESELLER, { userId: OUTSIDER }, T0)).rejects.toMatchObject({ reason: 'user_not_found' });
    // The owner is the platform's customer, not a seat (ADR-0059, ADR-0062).
    await expect(service.invite(owner, RESELLER, { userId: OWNER }, T0)).rejects.toMatchObject({ reason: 'user_not_found' });
    // A stranger gets nothing, including whether the reseller exists.
    const stranger = { userId: OUTSIDER, tenantId: PLATFORM, permissions: [] as string[] };
    await expect(service.invite(stranger, RESELLER, { userId: MEMBER }, T0)).rejects.toMatchObject({ reason: 'not_allowed' });
  });

  it('is one row per person: a second invite is refused, a removed one is re-invited in place', async () => {
    const { service, rows } = build();
    await service.invite(owner, RESELLER, { userId: MEMBER }, T0);
    await expect(service.invite(owner, RESELLER, { userId: MEMBER }, T0)).rejects.toMatchObject({ reason: 'already_staff' });

    const removed = await service.remove(platformStaff, RESELLER, rows[0].id, T0);
    expect(removed.state).toBe('revoked');
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toEqual(T0);

    const again = await service.invite(owner, RESELLER, { userId: MEMBER, accessExpiresAt: LATER }, T0);
    expect(again.id).toBe(rows[0].id);
    expect(again.state).toBe('invited');
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBeNull();
    expect(rows[0].joinedAt).toBeNull();
    expect(rows[0].accessExpiresAt).toEqual(LATER);
  });

  it('is accepted by the invitee themselves, once', async () => {
    const { service, rows } = build({ rows: [{}] });
    const view = await service.accept(member, RESELLER, T0);
    expect(view).toMatchObject({ state: 'active', joinedAt: T0 });
    await expect(service.accept(member, RESELLER, T0)).rejects.toMatchObject({ reason: 'no_invite' });

    // Nobody accepts on someone else's behalf, and no other tenant's session reaches the row.
    const { service: other } = build({ rows: [{}] });
    await expect(other.accept(owner, RESELLER, T0)).rejects.toMatchObject({ reason: 'no_invite' });
    await expect(other.accept({ ...member, tenantId: PLATFORM }, RESELLER, T0)).rejects.toMatchObject({ reason: 'no_invite' });
    expect(rows[0].joinedAt).toEqual(T0);
  });

  it('reports the four states, and a suspended reseller reads its team but does not change it', async () => {
    const past = new Date('2026-09-18T10:00:00Z');
    const { service } = build({
      status: 'suspended',
      rows: [{ joinedAt: past, accessExpiresAt: new Date('2026-09-19T09:00:00Z') }],
    });
    const [expired] = await service.list(owner, RESELLER, T0);
    expect(expired.state).toBe('expired');

    await expect(service.invite(owner, RESELLER, { userId: MEMBER }, T0)).rejects.toMatchObject({ reason: 'reseller_suspended' });
    // The platform owner's staff are not held to the reseller's matrix.
    await expect(service.invite(platformStaff, RESELLER, { userId: MEMBER }, T0)).rejects.toMatchObject({ reason: 'already_staff' });
  });

  it('refuses an expiry that is already past, and a member who is not this reseller\'s', async () => {
    const { service } = build();
    await expect(service.invite(owner, RESELLER, { userId: MEMBER, accessExpiresAt: new Date('2026-09-19T09:59:00Z') }, T0)).rejects.toMatchObject({
      reason: 'expiry_past',
    });
    await expect(service.remove(owner, RESELLER, 'row-nope', T0)).rejects.toMatchObject({ reason: 'staff_not_found' });
  });

  it('takes a date, a user id and nothing else', () => {
    expect(inviteStaffSchema.safeParse({ userId: MEMBER }).success).toBe(true);
    expect(inviteStaffSchema.safeParse({ userId: MEMBER, accessExpiresAt: '2026-10-19T10:00:00.000Z' }).data?.accessExpiresAt).toEqual(LATER);
    expect(inviteStaffSchema.safeParse({ userId: 'sara' }).success).toBe(false);
    expect(inviteStaffSchema.safeParse({ userId: MEMBER, joinedAt: '2026-10-19T10:00:00.000Z' }).success).toBe(false);
    expect(inviteStaffSchema.safeParse({ userId: MEMBER, accessExpiresAt: 'soon' }).success).toBe(false);
  });

  it('refuses a seat past the reseller\'s staff_members_max to its own people only; removed and expired seats do not count (F-019-t1)', async () => {
    const { service, rows } = build({
      staffLimit: 2,
      rows: [
        { userId: SECOND, joinedAt: T0 },
        { userId: OUTSIDER, revokedAt: T0 },
        { userId: OWNER, accessExpiresAt: T0 },
      ],
    });
    await service.invite(owner, RESELLER, { userId: MEMBER }, LATER);
    const e = await service.invite(owner, RESELLER, { userId: THIRD }, LATER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ResellerLimitReached);
    expect((e as ResellerLimitReached).facts).toEqual({ key: 'staff_members_max', limit: 2, used: 2 });
    expect(rows.filter((r) => r.userId === THIRD)).toHaveLength(0);
    // The platform's staff acting on the reseller are never bounded (ADR-0106 point 4).
    await expect(service.invite(platformStaff, RESELLER, { userId: THIRD }, LATER)).resolves.toMatchObject({ userId: THIRD });
  });

  it('names every refusal', () => {
    expect(new StaffRefused('already_staff', MEMBER).message).toContain('already_staff');
  });
});
