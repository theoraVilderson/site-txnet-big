import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTenant } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from './cross-tenant-prisma.service';
import { PrismaService } from './prisma.service';

/**
 * The two pools this service talks to Postgres through (ADR-0024, ADR-0077).
 *
 * A factory for the reason `auth-service/src/app/prisma/prisma.module.ts`
 * documents: `$extends` returns a new client, so the `PrismaService` token
 * resolves to the extended one and no call site opts in.
 *
 * `withTenant` scopes the models in `TENANT_SCOPED_MODELS`, and none of the
 * tables this service writes is one of them. It is still applied, for what it
 * carries besides the scoping: nothing here may quietly acquire a query on
 * `user` or `walletTransaction` that runs under no tenant. The RLS binding the
 * writes below *do* need is `tenantTransaction`'s, opened per delta by
 * `MeteringService`.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => {
        const base = new PrismaService(config.get('DATABASE_APP_URL', { infer: true }));
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
