import { NotFoundException } from '@nestjs/common';
import { TenantContext } from '@txnet-backend/shared-core';
import { describe, expect, it, vi } from 'vitest';

import { CallbackTenantMiddleware } from './callback-tenant.middleware';

describe('CallbackTenantMiddleware', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';

  const run = async (purpose: string, host = 'api.txnet.cyou') => {
    const prisma = {
      tenantDomain: {
        findUnique: vi.fn(async () => ({ tenantId: TENANT, domainType: 'subdomain', purpose, verificationStatus: 'verified' })),
      },
    };
    let seen: string | undefined;
    const next = vi.fn(() => {
      seen = TenantContext.currentOrNull()?.id;
    });
    await new CallbackTenantMiddleware(prisma as never).use({ headers: { host } } as never, {} as never, next);
    return { next, seen };
  };

  // A relay sends the bank's redirect to the platform's api host (3a474da8 made it `api`, 2026-10-06).
  it('takes the callback on an api door as on a panel one', async () => {
    const { next, seen } = await run('api');
    expect(next).toHaveBeenCalledTimes(1);
    expect(seen).toBe(TENANT);
  });

  it('takes it on a panel door', async () => {
    expect((await run('panel', 'panel.txnet.cyou')).seen).toBe(TENANT);
  });

  it('answers a subscription host with the neutral 404', async () => {
    await expect(run('subscription', 'sub.txnet.cyou')).rejects.toBeInstanceOf(NotFoundException);
  });
});
