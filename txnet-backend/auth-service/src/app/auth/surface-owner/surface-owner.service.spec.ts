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
