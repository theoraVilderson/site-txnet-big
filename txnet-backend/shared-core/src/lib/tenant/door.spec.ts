import { describe, expect, it } from 'vitest';
import { answersAsPanel, doorClosed, doorServesPanel } from './door';
import { isHostSurface } from './host-surface';

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

  it('serves no panel page on an api door: the gateway host is never a link target', () => {
    expect(doorServesPanel({ ...platformPanel, purpose: 'api' })).toBe(false);
  });

  it('answers the API on an api door exactly as on a panel one, and on nothing else', () => {
    expect(answersAsPanel('panel')).toBe(true);
    expect(answersAsPanel('api')).toBe(true);
    expect(answersAsPanel('subscription')).toBe(false);
    expect(answersAsPanel('assets')).toBe(false);
  });

  // F-204-a: the old panel's subscription host answers sub-service's paths alone.
  it('serves no panel and no API on a legacy_sub door, and caches it as a door', () => {
    const legacy = { ...resellerCustom, purpose: 'legacy_sub' } as const;
    expect(doorServesPanel(legacy)).toBe(false);
    expect(answersAsPanel('legacy_sub')).toBe(false);
    // An entry this code does not recognise is re-read every request: the old host would cost Postgres a read per fetch.
    expect(isHostSurface({ id: 't', slug: 'ali-vpn', ownerUserId: 'u', ...legacy })).toBe(true);
  });

  it("serves no panel on a reseller's platform subdomain", () => {
    expect(doorServesPanel(resellerSub)).toBe(false);
  });

  it('serves the panel when there is no surface to judge', () => {
    expect(doorServesPanel({})).toBe(true);
  });
});
