import { describe, expect, it } from 'vitest';
import { bestHostOf, panelHostOf, platformDomainOf } from './host';

/**
 * `panelHostOf` names the host a person is *sent* to — the handoff to a
 * reseller's panel (F-061-f), a bank's return (F-104), a branding URL (F-018-h).
 * A reseller's platform subdomain serves nothing (ADR-0063, `doorClosed`), so
 * for a reseller only its own proven custom domain is an answer, and no
 * answer is better than a 404 (F-018-aj). The platform owner's own subdomains
 * (`panel.<domain>`) are its doors and still count.
 */
describe('panelHostOf', () => {
  const sub = (domainValue: string) => ({ domainValue, domainType: 'subdomain' as const });
  const custom = (domainValue: string) => ({ domainValue, domainType: 'custom_domain' as const });

  it("answers a reseller's own custom domain, alphabetically, over any platform subdomain", () => {
    expect(panelHostOf([sub('ali.txnet.app'), custom('zz.ali.ir'), custom('panel.ali.ir')], 'reseller')).toBe('panel.ali.ir');
  });

  it('answers nothing for a reseller with only platform subdomains — the target or a pre-ADR-0063 row', () => {
    expect(panelHostOf([sub('ali.edge.txnet.app'), sub('ali.txnet.app')], 'reseller')).toBeNull();
    expect(panelHostOf([], 'reseller')).toBeNull();
  });

  it("answers the platform owner's own subdomain, and never a CNAME target", () => {
    expect(panelHostOf([sub('panel.txnet.app'), sub('api.txnet.app')], 'platform_owner')).toBe('api.txnet.app');
    expect(panelHostOf([sub('x.edge.txnet.app')], 'platform_owner')).toBeNull();
  });

  it('keeps a custom domain whose second label is `edge` — that name is the tenant\'s own', () => {
    expect(panelHostOf([custom('shop.edge.ir')], 'reseller')).toBe('shop.edge.ir');
  });
});

/**
 * The platform answers on two domains (ADR-0165): what a user keeps or a
 * domestic system calls back is built on the domestic one, which a cut of the
 * international links leaves reachable (NIN-1-d3).
 */
describe('bestHostOf', () => {
  const sub = (domainValue: string) => ({ domainValue, domainType: 'subdomain' as const });
  const custom = (domainValue: string) => ({ domainValue, domainType: 'custom_domain' as const });

  it('prefers a proven custom domain, then a subdomain, each alphabetically, and never a CNAME target', () => {
    expect(bestHostOf([sub('b.sub.txnet.app'), custom('z.example.com'), custom('a.example.com')])).toBe('a.example.com');
    expect(bestHostOf([sub('b.sub.txnet.app'), sub('a.sub.txnet.app')])).toBe('a.sub.txnet.app');
    expect(bestHostOf([sub('r1.edge.txnet.app')])).toBeNull();
    expect(bestHostOf([])).toBeNull();
  });

  it('puts a host on the domestic domain before one on the Cloudflare domain, whatever the alphabet says', () => {
    expect(bestHostOf([sub('sub.alpha.app'), sub('sub.zeta.ir')], 'zeta.ir')).toBe('sub.zeta.ir');
    expect(bestHostOf([sub('sub.alpha.app'), sub('sub.zeta.ir')])).toBe('sub.alpha.app');
    // A name that only ends like the domain is not on it.
    expect(bestHostOf([sub('sub.alpha.app'), sub('sub.notzeta.ir')], 'zeta.ir')).toBe('sub.alpha.app');
  });

  it("keeps a tenant's own proven domain ahead of the platform's domestic one", () => {
    expect(bestHostOf([sub('panel.zeta.ir'), custom('shop.reseller.com')], 'zeta.ir')).toBe('shop.reseller.com');
  });

  it("is what panelHostOf answers for the platform's own doors", () => {
    expect(panelHostOf([sub('panel.alpha.app'), sub('panel.zeta.ir')], 'platform_owner', 'zeta.ir')).toBe('panel.zeta.ir');
  });
});

describe('platformDomainOf', () => {
  const domains = { domain: 'alpha.app', domestic: 'zeta.ir' };

  it('answers the domestic domain for the domestic door, the Cloudflare one for its own', () => {
    expect(platformDomainOf('domestic', domains)).toBe('zeta.ir');
    expect(platformDomainOf('cloudflare', domains)).toBe('alpha.app');
  });

  it('falls back to DOMAIN_NAME when no domestic domain is set, and answers nothing with neither', () => {
    expect(platformDomainOf('domestic', { domain: 'alpha.app', domestic: '' })).toBe('alpha.app');
    expect(platformDomainOf('domestic', {})).toBeNull();
  });
});
