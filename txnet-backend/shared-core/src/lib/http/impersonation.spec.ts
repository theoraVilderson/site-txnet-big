import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { IMPERSONATION_REACH, impersonationMayReach } from './impersonation';

/**
 * AC-1-g (catalog §3.6 layer 4, ADR-0136). `contracts/http/impersonation.json`
 * is the list; this copy and auth-handler's (`impersonation.go`) are pinned to
 * it, the way `wire.json` is held (ADR-0036).
 */
const FIXTURE = join(__dirname, '../../../../../contracts/http/impersonation.json');

describe('the impersonation list', () => {
  it('is exactly the fixture', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { allow: unknown[] };
    expect(IMPERSONATION_REACH).toEqual(fixture.allow);
  });

  it('admits a listed route, a `:name` segment matching one segment', () => {
    expect(impersonationMayReach('GET', '/api/auth/me')).toBe(true);
    expect(impersonationMayReach('POST', '/api/auth/impersonate/end')).toBe(true);
    expect(impersonationMayReach('GET', '/api/billing/invoices/inv-1?x=1')).toBe(true);
  });

  it('closes everything else — a forbidden route, an unlisted one, another method, an unclean path', () => {
    for (const [method, uri] of [
      ['POST', '/api/auth/me/password'],
      ['POST', '/api/auth/accounts/switch'],
      ['GET', '/api/auth/sessions'],
      ['GET', '/api/auth/brand-new'],
      ['DELETE', '/api/auth/me'],
      ['GET', '/api/auth/me/'],
      ['GET', '/api/auth/me/../roles'],
      ['GET', '/api/auth/%6de'],
      ['GET', '/api/billing/invoices/'],
      ['', '/api/auth/me'],
      ['GET', ''],
    ]) {
      expect([method, uri, impersonationMayReach(method, uri)]).toEqual([method, uri, false]);
    }
  });
});
