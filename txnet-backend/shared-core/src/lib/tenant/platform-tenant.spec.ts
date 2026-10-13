import { TenantType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { isPlatformTenant, PLATFORM_TENANT_TYPE } from './platform-tenant';

// C-18 (CS-1-c): every backend caller asks "is this the platform's own tenant"
// here; a type nobody read is not the platform's.
describe('isPlatformTenant', () => {
  it("is the platform's own tenant type only", () => {
    expect(PLATFORM_TENANT_TYPE).toBe(TenantType.platform_owner);
    expect(isPlatformTenant(TenantType.platform_owner)).toBe(true);
    expect(isPlatformTenant(TenantType.reseller)).toBe(false);
  });

  it('is not the platform when no tenant was found', () => {
    expect(isPlatformTenant(null)).toBe(false);
    expect(isPlatformTenant(undefined)).toBe(false);
  });
});
