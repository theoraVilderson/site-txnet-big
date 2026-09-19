import { describe, expect, it } from 'vitest';
import { panelHostOf } from './host';

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
