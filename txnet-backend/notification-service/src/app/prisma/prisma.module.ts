import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTenant } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from './cross-tenant-prisma.service';
import { PrismaService } from './prisma.service';

/**
 * Two pools. `PrismaService`, extended with `withTenant` like every service's
 * (F-094); `notificationCampaign` is in `TENANT_SCOPED_MODELS`, so a tenant
 * admin's campaign queries bind their tenant. `CrossTenantPrismaService`, held
 * by campaign management for the platform owner alone (ADR-0053), not extended.
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
  ],
  exports: [PrismaService, CrossTenantPrismaService],
})
export class PrismaModule {}
