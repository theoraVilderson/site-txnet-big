import { ResellerAccess } from '@txnet-backend/shared-core';

import { setTenantTimeZoneSchema } from './tenant-time-zone.schema';
import { TenantTimeZoneRefused, TenantTimeZoneService } from './tenant-time-zone.service';

/**
 * The invariants TZ-1-d turns on (ADR-0108 points 2, 3, 7).
 *
 * - A tenant's zone is an IANA name, stored canonical; a fixed offset is refused.
 * - A set to the zone it already has writes nothing.
 * - A reseller's is reached through `ResellerAccess` (`staffWrite` to set); the
 *   platform's only by its own staff holding `tenant.manage`.
 */
describe('TenantTimeZoneService', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OTHER = '33333333-3333-3333-3333-333333333333';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'] };
  const stranger = { userId: STAFF, tenantId: PLATFORM, permissions: [] as string[] };
  const resellerAdmin = { userId: OWNER, tenantId: OTHER, permissions: ['tenant.manage'] };

  const build = (opts: { status?: string } = {}) => {
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform_owner', ownerUserId: STAFF, status: 'active', deletedAt: null, timezone: 'Asia/Tehran' },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status: opts.status ?? 'active', graceEndsAt: null, deletedAt: null, timezone: 'Asia/Tehran' },
    };
    const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null);
    const appPrisma = { tenant: { findUnique, findFirst: findUnique } };
    const update = vi.fn(async ({ where, data }: { where: { id: string }; data: { timezone: string } }) => {
      tenants[where.id].timezone = data.timezone;
      return tenants[where.id];
    });
    const all = { tenant: { findUnique, update } };
    const service = new TenantTimeZoneService(new ResellerAccess(appPrisma as never), all as never);
    return { service, tenants, update };
  };

  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof TenantTimeZoneRefused) return e.reason;
      throw e;
    }
    return 'accepted';
  };

  it("reads the tenant's zone, the platform default for one that never chose", async () => {
    expect(await build().service.read(owner, RESELLER)).toEqual({ timezone: 'Asia/Tehran' });
  });

  it('stores the canonical IANA name', async () => {
    const { service, tenants } = build();
    expect(await service.set(owner, RESELLER, 'europe/berlin')).toEqual({ timezone: 'Europe/Berlin' });
    expect(tenants[RESELLER].timezone).toBe('Europe/Berlin');
    expect((await service.set(staff, RESELLER, 'Iran')).timezone).toBe('Asia/Tehran');
  });

  it('a set to the zone it already has writes nothing', async () => {
    const { service, update } = build();
    expect((await service.set(owner, RESELLER, 'Asia/Tehran')).timezone).toBe('Asia/Tehran');
    expect(update).not.toHaveBeenCalled();
  });

  it("lets the platform's own staff set the platform's zone, and nobody else", async () => {
    const { service } = build();
    expect((await service.set(staff, PLATFORM, 'Asia/Dubai')).timezone).toBe('Asia/Dubai');
    expect(await refusal(service.read(stranger, PLATFORM))).toBe('not_allowed');
    expect(await refusal(service.read(owner, PLATFORM))).toBe('not_allowed');
    expect(await refusal(service.set(resellerAdmin, PLATFORM, 'Asia/Dubai'))).toBe('not_allowed');
  });

  it("refuses a stranger, and a suspended reseller's owner writing", async () => {
    expect(await refusal(build().service.read(stranger, RESELLER))).toBe('not_allowed');
    const { service, update } = build({ status: 'suspended' });
    expect((await service.read(owner, RESELLER)).timezone).toBe('Asia/Tehran');
    expect(await refusal(service.set(owner, RESELLER, 'Asia/Dubai'))).toBe('reseller_suspended');
    expect(update).not.toHaveBeenCalled();
  });

  it('takes an IANA zone and nothing else — no offset, no extra field', () => {
    expect(setTenantTimeZoneSchema.safeParse({ zone: 'Asia/Tehran' }).success).toBe(true);
    for (const body of [{ zone: '+03:30' }, { zone: 'Mars/Olympus' }, { zone: '' }, { zone: null }, {}, { zone: 'UTC', extra: 1 }]) {
      expect(setTenantTimeZoneSchema.safeParse(body).success).toBe(false);
    }
  });
});
