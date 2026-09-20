import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RESELLER_ACCESS_READER, withTenant } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from './cross-tenant-prisma.service';
import { PrismaService } from './prisma.service';

/**
 * Two pools. `PrismaService`, extended with `withTenant` like every service's
 * (F-094); `notificationCampaign` is in `TENANT_SCOPED_MODELS`, so a tenant
 * admin's campaign queries bind their tenant. `CrossTenantPrismaService`, held
 * by campaign management for the platform owner alone (ADR-0053), not extended.
 * `RESELLER_ACCESS_READER` is the app pool too (F-313-d), so a reseller-named
 * campaign route is admitted before it reaches either.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => {
        const base = new PrismaService(
          config.get('DATABASE_APP_URL', { infer: true }),
        );
        return base.$extends(withTenant(base)) as unknown as PrismaService;
      },
    },
    // `ResellerAccess` (F-066-w1) reads `tenant.tenant` and a staff seat on the
    // **app** pool, before any cross-tenant access is justified (ADR-0053).
    { provide: RESELLER_ACCESS_READER, useExisting: PrismaService },
    {
      provide: CrossTenantPrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) =>
        new CrossTenantPrismaService(config.get('DATABASE_CROSS_TENANT_URL', { infer: true })),
    },
  ],
  exports: [PrismaService, CrossTenantPrismaService, RESELLER_ACCESS_READER],
})
export class PrismaModule {}
