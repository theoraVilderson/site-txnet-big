import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TENANT_STATUSES,
  TenantOnboardingPolicy,
  TenantStatusPolicy,
  type TenantStatusRule,
  parseTenantStatusState,
  tenantAllows,
} from './status-policy';

/**
 * The TypeScript half of `contracts/tenant/subscription-link.json` (F-113-g).
 *
 * sub-service is Go, outside the workspace, and copies the `subscriptionLink`
 * column instead of importing it. Its half is
 * `sub-service/internal/sub/tenant_contract_test.go`; this one holds the
 * matrix to the same fixture, so a column changed here alone goes red here
 * rather than letting `/sub` keep serving what the matrix now refuses.
 */

const FIXTURE = join(__dirname, '../../../../../contracts/tenant/subscription-link.json');

interface LinkFixture {
  column: Record<string, TenantStatusRule>;
  onboarding: TenantStatusRule;
  now: string;
  cases: Array<{ name: string; raw: string; allowed: boolean }>;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as LinkFixture;

describe('contracts/tenant/subscription-link.json', () => {
  it('declares the subscriptionLink column of every status, and no other status', () => {
    const column = Object.fromEntries(
      TENANT_STATUSES.map((status) => [status, TenantStatusPolicy[status].subscriptionLink]),
    );
    expect(column).toEqual(fixture.column);
  });

  it('declares the onboarding column', () => {
    expect(TenantOnboardingPolicy.subscriptionLink).toBe(fixture.onboarding);
  });

  // What sub-service does with the raw key: parse it as the guard does, and
  // a value the parser rejects refuses nobody.
  it.each(fixture.cases)('$name -> allowed $allowed', ({ raw, allowed }) => {
    const state = parseTenantStatusState(raw);
    const judged = !state || tenantAllows(state, 'subscriptionLink', new Date(fixture.now));
    expect(judged).toBe(allowed);
  });
});
