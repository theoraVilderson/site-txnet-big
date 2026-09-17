import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTenant } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { PrismaService } from './prisma.service';

/**
 * One pool, extended with `withTenant` like every service's (F-094). No
 * `notification` model is tenant-scoped today, so the extension binds nothing
 * here yet; it is applied anyway so that `notification_campaign` (F-035-c)
 * is scoped the day it is queried, with no call site opting in.
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
