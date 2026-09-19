import { describe, expect, it, vi } from 'vitest';
import { tenantOfHost } from './host-tenant';

/**
 * `tenantOfHost` is how `tenant-service` (files, branding) and
 * `billing-service` (the bank's callback) name the tenant of a public request
 * from its Host. A reseller's CNAME target, `<slug>.edge.<domain>`, is never
 * one of those doors (ADR-0063): it only connects the reseller's own domain,
 * so a request that arrives *as* it — someone opening it directly, or a CDN
 * that rewrites the host — is refused like an unknown host.
 */
describe('tenantOfHost', () => {
  const rows: Record<string, Record<string, unknown>> = {
    'panel.txnet.app': { tenantId: 'platform', domainType: 'subdomain', purpose: 'panel', verificationStatus: 'verified' },
    'acme.edge.txnet.app': { tenantId: 'acme', domainType: 'subdomain', purpose: 'panel', verificationStatus: 'pending' },
    'shop-acme.com': { tenantId: 'acme', domainType: 'custom_domain', purpose: 'panel', verificationStatus: 'verified' },
    'new-acme.com': { tenantId: 'acme', domainType: 'custom_domain', purpose: 'panel', verificationStatus: 'pending' },
    // A reseller's own domain may have `edge` as its second label; that is its
    // name, not our target.
    'x.edge.shop.ir': { tenantId: 'acme', domainType: 'custom_domain', purpose: 'panel', verificationStatus: 'verified' },
  };
  const db = {
    tenantDomain: {
      findUnique: vi.fn(async ({ where }: { where: { domainValue: string } }) => rows[where.domainValue] ?? null),
    },
  } as never;

  it("never names a tenant for a reseller's CNAME target", async () => {
    await expect(tenantOfHost(db, 'acme.edge.txnet.app', ['panel'])).resolves.toBeNull();
  });

  it("still names the platform's own panel subdomain", async () => {
    await expect(tenantOfHost(db, 'panel.txnet.app', ['panel'])).resolves.toBe('platform');
  });

  it('names a proved custom domain, and not an unproved one', async () => {
    await expect(tenantOfHost(db, 'shop-acme.com', ['panel'])).resolves.toBe('acme');
    await expect(tenantOfHost(db, 'new-acme.com', ['panel'])).resolves.toBeNull();
  });

  it("does not mistake a reseller's own `edge` label for our target", async () => {
    await expect(tenantOfHost(db, 'x.edge.shop.ir', ['panel'])).resolves.toBe('acme');
  });
});
