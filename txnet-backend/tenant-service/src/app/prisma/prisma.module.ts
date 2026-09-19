import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RESELLER_ACCESS_READER, withTenant } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from './cross-tenant-prisma.service';
import { PrismaService } from './prisma.service';

/**
 * Two pools, as in `notification-service`. `PrismaService`, extended with
 * `withTenant` like every service's (F-094); `CrossTenantPrismaService`, for
 * the platform owner alone (ADR-0053), not extended. `ResellerAccess`
 * (shared-core, F-066-w1) reads on the app pool, bound here once.
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
    {
      provide: CrossTenantPrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) =>
        new CrossTenantPrismaService(config.get('DATABASE_CROSS_TENANT_URL', { infer: true })),
    },
    { provide: RESELLER_ACCESS_READER, useExisting: PrismaService },
  ],
  exports: [PrismaService, CrossTenantPrismaService, RESELLER_ACCESS_READER],
})
export class PrismaModule {}
