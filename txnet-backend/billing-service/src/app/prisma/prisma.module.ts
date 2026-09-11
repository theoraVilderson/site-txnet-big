import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTenant } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { PrismaService } from './prisma.service';

/**
 * The tenant-scoped client every billing service injects (ADR-0024).
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
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
