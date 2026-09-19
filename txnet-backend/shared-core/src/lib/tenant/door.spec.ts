import { describe, expect, it } from 'vitest';
import { doorClosed, doorServesPanel } from './door';

/**
 * The door rules, once, for every process that answers on a Host (F-018-ak).
 * `auth-service`'s `TenantGuard` refuses on them and `tenant-service`'s public
 * routes do the same; the panel asks `GET /api/public/tenant/serves-panel`.
 */
describe('door rules', () => {
  const platformPanel = { purpose: 'panel', domainType: 'subdomain', tenantType: 'platform_owner' } as const;
  const resellerSub = { purpose: 'panel', domainType: 'subdomain', tenantType: 'reseller' } as const;
  const resellerCustom = { purpose: 'panel', domainType: 'custom_domain', tenantType: 'reseller' } as const;

  it("closes a reseller's platform subdomain, and nothing else (ADR-0063)", () => {
    expect(doorClosed(resellerSub)).toBe(true);
    expect(doorClosed(platformPanel)).toBe(false);
    expect(doorClosed(resellerCustom)).toBe(false);
  });

  it('serves the panel on an open panel door', () => {
    expect(doorServesPanel(platformPanel)).toBe(true);
    expect(doorServesPanel(resellerCustom)).toBe(true);
  });

  it('serves no panel on a subscription or assets door (F-066-q)', () => {
    expect(doorServesPanel({ ...resellerCustom, purpose: 'subscription' })).toBe(false);
    expect(doorServesPanel({ ...resellerCustom, purpose: 'assets' })).toBe(false);
  });

  it("serves no panel on a reseller's platform subdomain", () => {
    expect(doorServesPanel(resellerSub)).toBe(false);
  });

  it('serves the panel when there is no surface to judge', () => {
    expect(doorServesPanel({})).toBe(true);
  });
});
