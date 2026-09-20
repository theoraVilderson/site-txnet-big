import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RESELLER_ACCESS_READER, withTenant } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from './cross-tenant-prisma.service';
import { PrismaService } from './prisma.service';

/**
 * The two pools this service talks to Postgres through (ADR-0024, F-092-j).
 *
 * `PrismaService` is the one everything injects. `CrossTenantPrismaService` is
 * the other, held by exactly one reader — the public gateway callback's
 * middleware, whose lookup is what *produces* a tenant and so cannot run inside
 * one. It is not extended with `withTenant`, for the reason that class gives.
 *
 * A factory for the reason `auth-service/src/app/prisma/prisma.module.ts`
 * documents: `$extends` returns a new client, so the `PrismaService` token
 * resolves to the extended one and no call site opts in. `withTenant` is the
 * `shared-core` rule itself (F-094), not a copy; it is handed the base client
 * because it binds `app.tenant_id` in a transaction beside each scoped query.
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
        new CrossTenantPrismaService(
          config.get('DATABASE_CROSS_TENANT_URL', { infer: true }),
        ),
    },
  ],
  exports: [PrismaService, CrossTenantPrismaService, RESELLER_ACCESS_READER],
})
export class PrismaModule {}
