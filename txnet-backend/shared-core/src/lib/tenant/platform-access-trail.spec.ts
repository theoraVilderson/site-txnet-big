import { TenantContext } from '../tenant-context/tenant-context';
import { accessTraceOf } from './platform-access-trail';
import { ResellerAccess } from './reseller-access';

/**
 * The invariant F-117-c turns on (ADR-0104 (6)): **every request the platform's
 * staff make among a reseller's people is one row in that reseller's own
 * trail** — actor, tier, consent id, act and target — reads included, written
 * by the door that admitted it, in the reseller's tenant, before the work runs.
 * The reseller's own people, and a refused caller, leave no such row.
 */
describe('platform access trail', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';
  const USER = '66666666-6666-6666-6666-666666666666';
  const T0 = new Date('2026-10-04T10:00:00Z');

  const trace = { act: 'GET /api/auth/tenants/:tenantId/users', target: {}, ip: '203.0.113.7' };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'], trace };
  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[], trace };

  type Entry = { id: string; userId: string; expiresAt: Date };
  const build = (scope: 'read' | 'act' | null, entries: Entry[] = []) => {
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform_owner', ownerUserId: STAFF, status: 'active' },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status: 'active', graceEndsAt: null },
    };
    const rows: { tenantInScope: string; data: Record<string, unknown> }[] = [];
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      supportAccessConsent: {
        findFirst: vi.fn(async () => (scope ? { id: 'consent-9', scope, expiresAt: new Date('2026-10-04T14:00:00Z') } : null)),
      },
      emergencyAccessEntry: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string; expiresAt: { gt: Date } } }) =>
          entries.find((e) => e.userId === where.userId && e.expiresAt > where.expiresAt.gt) ?? null,
        ),
      },
      adminAuditLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.push({ tenantInScope: TenantContext.current().id, data });
        }),
      },
    };
    const prisma = {
      tenant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
      },
      tenantStaffMember: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    return { access: new ResellerAccess(prisma as never), rows };
  };

  it("writes one row in the reseller's trail for each request staff make under its consent, reads included", async () => {
    const { access, rows } = build('read');
    const order: string[] = [];
    await access.runIncludingPlatform(staff, RESELLER, 'read', async () => void order.push(`work after ${rows.length} row`), T0);

    expect(order).toEqual(['work after 1 row']);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantInScope).toBe(RESELLER);
    expect(rows[0].data).toMatchObject({
      tenantId: RESELLER,
      adminId: STAFF,
      action: 'platform_access',
      targetEntityType: 'tenant',
      targetEntityId: RESELLER,
      adminIpAddress: '203.0.113.7',
      newValue: { tier: 'consent', consentId: 'consent-9', scope: 'read', capability: 'read', act: trace.act, target: {} },
    });
  });

  it('names the act and its target as the route does, so a write is told from a read', async () => {
    const { access, rows } = build('act');
    const write = { ...staff, trace: { act: 'POST /api/auth/tenants/:tenantId/users/:userId/block', target: { userId: USER }, ip: '203.0.113.7' } };
    await access.admitIncludingPlatform(write, RESELLER, 'staffWrite', T0);
    expect(rows[0].data['newValue']).toMatchObject({ tier: 'consent', scope: 'act', capability: 'staffWrite', target: { userId: USER } });
  });

  it("writes nothing for the reseller's own owner, nor for staff the consent refused", async () => {
    const { access, rows } = build(null);
    await access.admitIncludingPlatform(owner, RESELLER, 'read', T0);
    await expect(access.admitIncludingPlatform(staff, RESELLER, 'read', T0)).rejects.toMatchObject({ reason: 'consent_required' });
    const reading = build('read');
    await expect(reading.access.admitIncludingPlatform(staff, RESELLER, 'staffWrite', T0)).rejects.toMatchObject({ reason: 'consent_read_only' });
    expect([...rows, ...reading.rows]).toEqual([]);
  });

  it('reads the act from the route template and the target from the path, never the tenant twice', () => {
    const req = {
      method: 'POST',
      route: { path: '/api/billing/tenants/:tenantId/users/:userId/grants/:grantId/freeze' },
      params: { tenantId: RESELLER, userId: USER, grantId: 'g-1' },
      ip: '198.51.100.4',
    };
    expect(accessTraceOf(req as never)).toEqual({
      act: 'POST /api/billing/tenants/:tenantId/users/:userId/grants/:grantId/freeze',
      target: { userId: USER, grantId: 'g-1' },
      ip: '198.51.100.4',
    });
  });

  it('admits a running emergency entry as `act` for its entrant alone, recorded as tier C (F-117-d)', async () => {
    const entry = { id: 'entry-1', userId: STAFF, expiresAt: new Date('2026-10-04T10:30:00Z') };
    const emergency = { ...staff, permissions: ['tenant.manage', 'tenant.emergency_access'] };
    const { access, rows } = build('read', [entry]);
    await access.admitIncludingPlatform(emergency, RESELLER, 'staffWrite', T0);
    expect(rows[0].data['newValue']).toMatchObject({ tier: 'emergency', entryId: 'entry-1', scope: 'act', capability: 'staffWrite' });

    // Another staff member, the permission taken away, or the hour over: none of them get in.
    const colleague = { ...emergency, userId: OWNER.replace('4', '7') };
    await expect(access.admitIncludingPlatform(colleague, RESELLER, 'staffWrite', T0)).rejects.toMatchObject({ reason: 'consent_read_only' });
    await expect(access.admitIncludingPlatform(staff, RESELLER, 'staffWrite', T0)).rejects.toMatchObject({ reason: 'consent_read_only' });
    await expect(build(null, [entry]).access.admitIncludingPlatform(emergency, RESELLER, 'read', new Date('2026-10-04T10:31:00Z'))).rejects.toMatchObject({
      reason: 'consent_required',
    });
  });
});
