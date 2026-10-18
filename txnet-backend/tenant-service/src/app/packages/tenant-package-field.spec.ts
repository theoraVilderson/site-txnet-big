import { sanitizeError } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { TenantPackageController } from './tenant-package.controller';
import { createPackageSchema } from './tenant-package.schema';
import { TenantPackageRefused, type TenantPackageService } from './tenant-package.service';

/**
 * A refused package create tells the panel which field it was (PK-1-j): what
 * reaches the client is what `sanitizeError` lets through, so that is what is
 * asserted — not the exception the service threw. The wizard returns to the
 * step a `fieldErrors` path is on (ADR-0154 decision 4).
 *
 * - a part refused by the service: `error.reason` and a `fieldErrors` entry
 *   with the path and a locale key, together;
 * - a body refused by the schema: the path survives even when zod's message
 *   is its own English default and not a locale key.
 */
describe('a refused package create names its field to the client', () => {
  const req = { identity: { userId: 'u', tenantId: 't', roleId: 'r', sessionId: 's', permissions: ['platform.plan.assign'] } } as unknown as Request;
  const body = { name: 'Gold', monthlyPrice: '10.00', includedFeatureKeys: [] };

  it("keeps the service's reason beside the field it names", async () => {
    const packages = { create: async () => Promise.reject(new TenantPackageRefused('limit_out_of_range', 'staff_members_max ≤ 1000', 'limits.0.value')) };
    const controller = new TenantPackageController(packages as unknown as TenantPackageService);
    const thrown = await controller.create(req, { ...body, limits: [{ key: 'staff_members_max', value: 5000 }] }, '127.0.0.1').catch((e: unknown) => e);

    const out = sanitizeError(thrown);
    expect(out.status).toBe(422);
    expect(out.reason).toBe('limit_out_of_range');
    expect(out.fieldErrors).toEqual([{ path: 'limits.0.value', i18nKey: 'tenant.package.limitOutOfRange' }]);
  });

  it('a refusal with no field stays what it was', async () => {
    const packages = { create: async () => Promise.reject(new TenantPackageRefused('package_name_taken', 'Gold')) };
    const controller = new TenantPackageController(packages as unknown as TenantPackageService);
    const out = sanitizeError(await controller.create(req, body, '127.0.0.1').catch((e: unknown) => e));
    expect(out).toMatchObject({ status: 409, reason: 'package_name_taken' });
    expect(out.fieldErrors).toBeUndefined();
  });

  it("keeps the path of a schema refusal whose message is zod's own", () => {
    const pipe = new ZodValidationPipe(createPackageSchema);
    let thrown: unknown;
    try {
      pipe.transform({ ...body, limits: [{ key: 'staff_members_max', value: -1 }] });
    } catch (e) {
      thrown = e;
    }
    expect(sanitizeError(thrown).fieldErrors).toEqual([{ path: 'limits.0.value', i18nKey: 'validation.invalidValue' }]);
  });
});
