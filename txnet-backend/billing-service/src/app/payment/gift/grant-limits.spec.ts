/**
 * Staff read and set the metered cap (F-118-ap, over F-118-ao): a tenant's
 * default, and one user's own number — the answer to a ticket.
 *
 * What breaks without anyone seeing it:
 *  - **the wrong tenant's number.** The tenant is the path's, admitted by the
 *    users-admin door; the rows are written in its scope and carry its id;
 *  - **a number nobody can account for.** Every change writes an
 *    `admin_audit_log` row in its transaction — before, after, the reason — and
 *    a user's number is refused without a reason;
 *  - **a suspended reseller raising caps.** Reads pass `read`, writes
 *    `staffWrite`: a suspended reseller sees its numbers and changes none;
 *  - **another tenant's user.** A user id the tenant does not hold is
 *    `user_not_found`, decided before anything is read or written;
 *  - **the effective number lies.** It is `meteredCapOf`'s, the same the sale
 *    is refused by: the user's own, else the tenant's, else the platform's 5.
 */
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { grantLimitSchema, tenantGrantLimitSchema, userGrantLimitSchema } from './grant-limits.schema';
import { GrantLimitsService } from './grant-limits.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const SUSPENDED = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STAFF_USER = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const LATE_CUSTOMER = '77777777-7777-4777-8777-777777777777';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[], ip: '203.0.113.7' };
const staff = { userId: STAFF_USER, tenantId: PLATFORM, permissions: ['tenant.manage'], ip: '203.0.113.8' };
const stranger = { userId: CUSTOMER, tenantId: PLATFORM, permissions: [] as string[], ip: '203.0.113.9' };

function build(seed: { tenantCap?: number; userCap?: { meteredOpenCap: number; reason: string | null }; open?: number } = {}) {
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

  const userTenant: Record<string, string> = { [CUSTOMER]: RESELLER, [LATE_CUSTOMER]: SUSPENDED };
  let tenantRow: { tenantId: string; meteredOpenCap: number } | null =
    seed.tenantCap === undefined ? null : { tenantId: RESELLER, meteredOpenCap: seed.tenantCap };
  let userRow: Record<string, unknown> | null = seed.userCap
    ? { tenantId: RESELLER, userId: CUSTOMER, ...seed.userCap, setByUserId: STAFF_USER, updatedAt: new Date('2026-09-30T10:00:00Z') }
    : null;
  const audit: Array<Record<string, unknown>> = [];
  const writes: Array<{ what: string; scope: string | undefined; data: unknown }> = [];

  const tx = {
    $executeRaw: async () => 1,
    user: { findFirst: async ({ where }: { where: { id: string } }) => (userTenant[where.id] === scope() ? { id: where.id } : null) },
    grant: { count: async () => seed.open ?? 0 },
    grantLimitSetting: {
      findUnique: async () => tenantRow,
      upsert: async (args: { create: { tenantId: string; meteredOpenCap: number } }) => {
        writes.push({ what: 'tenant.upsert', scope: scope(), data: args.create });
        tenantRow = { tenantId: args.create.tenantId, meteredOpenCap: args.create.meteredOpenCap };
        return tenantRow;
      },
      deleteMany: async () => {
        writes.push({ what: 'tenant.delete', scope: scope(), data: null });
        const count = tenantRow ? 1 : 0;
        tenantRow = null;
        return { count };
      },
    },
    userGrantLimit: {
      findUnique: async () => userRow,
      upsert: async (args: { create: Record<string, unknown> }) => {
        writes.push({ what: 'user.upsert', scope: scope(), data: args.create });
        userRow = { ...args.create, updatedAt: new Date('2026-09-30T12:00:00Z') };
        return userRow;
      },
      deleteMany: async () => {
        writes.push({ what: 'user.delete', scope: scope(), data: null });
        const count = userRow ? 1 : 0;
        userRow = null;
        return { count };
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        audit.push(args.data);
        return { id: `audit-${audit.length}` };
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const service = new GrantLimitsService(prisma as never, access);
  return { service, audit, writes };
}

describe('GrantLimitsService — the tenant default', () => {
  it('reads the platform default, the tenant\'s own and the one in effect', async () => {
    await expect(build().service.tenantLimit(owner, RESELLER)).resolves.toEqual({ platformDefault: 5, tenantDefault: null, effective: 5 });
    await expect(build({ tenantCap: 2 }).service.tenantLimit(owner, RESELLER)).resolves.toEqual({ platformDefault: 5, tenantDefault: 2, effective: 2 });
  });

  it('sets it in the path\'s tenant and audits before and after', async () => {
    const { service, audit, writes } = build({ tenantCap: 2 });
    await expect(service.setTenantLimit(owner, RESELLER, 8)).resolves.toEqual({ platformDefault: 5, tenantDefault: 8, effective: 8 });
    expect(writes).toEqual([{ what: 'tenant.upsert', scope: RESELLER, data: { tenantId: RESELLER, meteredOpenCap: 8, updatedByUserId: OWNER_USER } }]);
    expect(audit).toEqual([
      expect.objectContaining({
        tenantId: RESELLER,
        adminId: OWNER_USER,
        action: 'grant_limit_tenant_set',
        targetEntityType: 'tenant',
        targetEntityId: RESELLER,
        oldValue: { meteredOpenCap: 2 },
        newValue: { meteredOpenCap: 8 },
        adminIpAddress: '203.0.113.7',
      }),
    ]);
  });

  it('null goes back to the platform\'s default; nothing to remove writes no audit row', async () => {
    const { service, audit } = build({ tenantCap: 2 });
    await expect(service.setTenantLimit(owner, RESELLER, null)).resolves.toEqual({ platformDefault: 5, tenantDefault: null, effective: 5 });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ oldValue: { meteredOpenCap: 2 }, newValue: { meteredOpenCap: null } });
    await service.setTenantLimit(owner, RESELLER, null);
    expect(audit).toHaveLength(1);
  });

  it('platform staff set the platform\'s own; a stranger is not_allowed; a suspended reseller reads but writes nothing', async () => {
    const platform = build();
    await expect(platform.service.setTenantLimit(staff, PLATFORM, 3)).resolves.toMatchObject({ tenantDefault: 3 });
    expect(platform.writes[0]).toMatchObject({ scope: PLATFORM });

    await expect(build().service.tenantLimit(stranger, RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });

    const late = build();
    await expect(late.service.tenantLimit(owner, SUSPENDED)).resolves.toMatchObject({ effective: 5 });
    await expect(late.service.setTenantLimit(owner, SUSPENDED, 9)).rejects.toMatchObject({ reason: 'reseller_suspended' });
    expect(late.writes).toEqual([]);
  });
});

describe('GrantLimitsService — one user\'s number', () => {
  it('reads their own, the defaults, the one in effect and how many they hold open', async () => {
    const { service } = build({ tenantCap: 2, userCap: { meteredOpenCap: 10, reason: 'ticket 41' }, open: 4 });
    await expect(service.userLimit(owner, RESELLER, CUSTOMER)).resolves.toEqual({
      userId: CUSTOMER,
      own: { meteredOpenCap: 10, reason: 'ticket 41', setByUserId: STAFF_USER, updatedAt: '2026-09-30T10:00:00.000Z' },
      tenantDefault: 2,
      platformDefault: 5,
      effective: 10,
      open: 4,
    });
  });

  it('sets it with a reason, in the tenant\'s scope, audited against the user', async () => {
    const { service, audit, writes } = build({ tenantCap: 2 });
    const answer = await service.setUserLimit(owner, RESELLER, CUSTOMER, 0, 'abuse, ticket 7');
    expect(answer).toMatchObject({ own: { meteredOpenCap: 0, reason: 'abuse, ticket 7', setByUserId: OWNER_USER }, effective: 0 });
    expect(writes).toEqual([
      { what: 'user.upsert', scope: RESELLER, data: { tenantId: RESELLER, userId: CUSTOMER, meteredOpenCap: 0, reason: 'abuse, ticket 7', setByUserId: OWNER_USER } },
    ]);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'grant_limit_user_set',
        targetEntityType: 'user',
        targetEntityId: CUSTOMER,
        oldValue: { meteredOpenCap: null },
        newValue: { meteredOpenCap: 0 },
        reason: 'abuse, ticket 7',
      }),
    ]);
  });

  it('removes it, back to the tenant\'s default, audited once', async () => {
    const { service, audit } = build({ tenantCap: 2, userCap: { meteredOpenCap: 10, reason: 'ticket 41' } });
    await expect(service.removeUserLimit(owner, RESELLER, CUSTOMER)).resolves.toMatchObject({ own: null, effective: 2 });
    expect(audit).toEqual([expect.objectContaining({ action: 'grant_limit_user_remove', oldValue: { meteredOpenCap: 10 }, newValue: { meteredOpenCap: null } })]);
    await service.removeUserLimit(owner, RESELLER, CUSTOMER);
    expect(audit).toHaveLength(1);
  });

  it('refuses a user the tenant does not hold before anything is written', async () => {
    const { service, writes, audit } = build();
    await expect(service.setUserLimit(owner, RESELLER, LATE_CUSTOMER, 3, 'x')).rejects.toMatchObject({ reason: 'user_not_found' });
    await expect(service.userLimit(owner, RESELLER, LATE_CUSTOMER)).rejects.toMatchObject({ reason: 'user_not_found' });
    expect(writes).toEqual([]);
    expect(audit).toEqual([]);
  });
});

describe('the bodies', () => {
  it('take a whole number 0..1000; the tenant\'s may be null, a user\'s needs a reason', () => {
    expect(grantLimitSchema.safeParse(0).success).toBe(true);
    expect(grantLimitSchema.safeParse(1000).success).toBe(true);
    for (const bad of [-1, 1001, 2.5, '3']) expect(grantLimitSchema.safeParse(bad).success).toBe(false);

    expect(tenantGrantLimitSchema.parse({ meteredOpenCap: null })).toEqual({ meteredOpenCap: null });
    expect(tenantGrantLimitSchema.safeParse({}).success).toBe(false);

    expect(userGrantLimitSchema.parse({ meteredOpenCap: 12, reason: '  ticket 9 ' })).toEqual({ meteredOpenCap: 12, reason: 'ticket 9' });
    expect(userGrantLimitSchema.safeParse({ meteredOpenCap: 12 }).success).toBe(false);
    expect(userGrantLimitSchema.safeParse({ meteredOpenCap: 12, reason: '   ' }).success).toBe(false);
    expect(userGrantLimitSchema.safeParse({ meteredOpenCap: null, reason: 'x' }).success).toBe(false);
  });
});
