import { SurfaceOwnerService } from './surface-owner.service';
import { TenantContext, runWithTenant } from '../../tenant-context/tenant-context';

/**
 * On a reseller's domain, a sign-in that matches none of that reseller's
 * accounts may still be its owner's own platform account (ADR-0059 (3)). This
 * is the only cross-tenant account read a sign-in makes, so what it must never
 * do is the point: look up anyone but the owner, or answer on a surface whose
 * tenant is the owner's own.
 */

const RESELLER = { id: 'tenant-reseller', slug: 'arian-vpn', via: 'domain', surfacePurpose: 'panel' } as const;
const WHERE = { phoneNumber: '+989121234567' };
const INCLUDE = { role: true };

function harness(ownerUserId: string | null = 'user-ali', user: unknown = {
  id: 'user-ali',
  tenantId: 'tenant-platform',
  tenant: { slug: 'platform_owner' },
}) {
  const all = {
    tenant: { findUnique: vi.fn().mockResolvedValue(ownerUserId ? { ownerUserId } : null) },
    user: { findFirst: vi.fn().mockResolvedValue(user) },
  };
  return { all, service: new SurfaceOwnerService(all as never) };
}

describe('SurfaceOwnerService.ownerMatching', () => {
  it("finds the surface tenant's owner by id and identifier, outside that tenant", async () => {
    const { service, all } = harness();

    const found = await runWithTenant(RESELLER as never, () =>
      service.ownerMatching(WHERE, INCLUDE),
    );

    expect(all.user.findFirst).toHaveBeenCalledWith({
      where: { ...WHERE, id: 'user-ali', tenantId: { not: RESELLER.id } },
      include: { ...INCLUDE, tenant: { select: { slug: true } } },
    });
    expect(found?.user).toMatchObject({ id: 'user-ali' });
    expect(found?.scope).toEqual({
      id: 'tenant-platform',
      slug: 'platform_owner',
      via: 'session',
      surfacePurpose: 'panel',
      brand: { id: RESELLER.id, slug: RESELLER.slug },
    });
  });

  it('answers null, and reads no account, when the tenant has no owner row', async () => {
    const { service, all } = harness(null);

    const found = await runWithTenant(RESELLER as never, () => service.ownerMatching(WHERE, INCLUDE));

    expect(found).toBeNull();
    expect(all.user.findFirst).not.toHaveBeenCalled();
  });

  it('answers null when the identifier is not the owner’s', async () => {
    const { service } = harness('user-ali', null);

    expect(
      await runWithTenant(RESELLER as never, () => service.ownerMatching(WHERE, INCLUDE)),
    ).toBeNull();
  });

  it('answers null outside a resolved surface, reading nothing', async () => {
    const { service, all } = harness();

    expect(await runWithTenant(null, () => service.ownerMatching(WHERE, INCLUDE))).toBeNull();
    expect(
      await runWithTenant({ ...RESELLER, via: 'session' } as never, () =>
        service.ownerMatching(WHERE, INCLUDE),
      ),
    ).toBeNull();
    expect(all.tenant.findUnique).not.toHaveBeenCalled();
    expect(TenantContext.currentOrNull()).toBeNull();
  });
});

/**
 * F-061-g: account switching and the Mini App ask "which accounts may hold a
 * session on this door?" — the surface tenant's own and its owner, and nobody
 * else (ADR-0059 (1)). A member outside that set would be switched to and then
 * refused on the next request.
 */
describe('SurfaceOwnerService — the surface and who it admits', () => {
  const OWNER_SCOPE = {
    id: 'tenant-platform',
    slug: 'platform_owner',
    via: 'session',
    surfacePurpose: 'panel',
    brand: { id: RESELLER.id, slug: RESELLER.slug },
  } as const;

  function readHarness(ownerUserId: string | null = 'user-ali') {
    const all = {
      tenant: { findUnique: vi.fn().mockResolvedValue({ ownerUserId }) },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    return { all, service: new SurfaceOwnerService(all as never) };
  }

  it("is the brand's door when the request runs in its owner's tenant", () => {
    const { service } = readHarness();

    expect(runWithTenant(OWNER_SCOPE as never, () => service.surface())).toEqual({
      id: RESELLER.id,
      slug: RESELLER.slug,
      via: 'domain',
      surfacePurpose: 'panel',
    });
  });

  it('is the tenant itself for a customer of the surface, and for a bot', () => {
    const { service } = readHarness();
    const customer = { ...RESELLER, via: 'session' } as const;
    const bot = { id: 'tenant-reseller', slug: 'arian-vpn', via: 'bot' } as const;

    expect(runWithTenant(customer as never, () => service.surface())).toEqual(RESELLER);
    expect(runWithTenant(bot as never, () => service.surface())).toEqual(bot);
    expect(runWithTenant(null, () => service.surface())).toBeNull();
  });

  it("admits the surface tenant's accounts and its owner, read across tenants", async () => {
    const { service, all } = readHarness();

    await runWithTenant(OWNER_SCOPE as never, () =>
      service.admissibleUsers(['a', 'b'], { id: true }),
    );

    expect(all.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['a', 'b'] },
        status: 'active',
        deletedAt: null,
        OR: [{ tenantId: RESELLER.id }, { id: 'user-ali' }],
      },
      select: { id: true },
    });
  });

  it('admits only its own accounts on a door that is not a panel', async () => {
    const { service, all } = readHarness();
    const bot = { id: 'tenant-reseller', slug: 'arian-vpn', via: 'bot' } as const;

    await runWithTenant(bot as never, () => service.admissibleUser('a', { role: true }));

    expect(all.tenant.findUnique).not.toHaveBeenCalled();
    expect(all.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'a', OR: [{ tenantId: 'tenant-reseller' }] },
      include: { role: true },
    });
  });

  it('admits nobody outside a resolved tenant, reading nothing', async () => {
    const { service, all } = readHarness();

    expect(await runWithTenant(null, () => service.admissibleUsers(['a'], { id: true }))).toEqual([]);
    expect(await runWithTenant(null, () => service.admissibleUser('a', {}))).toBeNull();
    expect(all.user.findMany).not.toHaveBeenCalled();
    expect(all.user.findFirst).not.toHaveBeenCalled();
  });
});
