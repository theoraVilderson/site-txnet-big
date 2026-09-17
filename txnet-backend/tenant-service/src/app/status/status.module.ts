import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';

import { TenantStatusController } from './tenant-status.controller';
import { TENANT_STATUS_LISTEN_CLIENT, TenantStatusListener } from './tenant-status.listener';
import { TenantStatusService } from './tenant-status.service';

/**
 * The platform owner suspends, reactivates and terminates a reseller (F-018-f),
 * moved out of `auth-service` with F-018-w (ADR-0058).
 *
 * `TenantStatusListener` ships in the same module as the route that moves a
 * tenant between statuses: one writes `tenant.tenant`, the other carries the
 * result to `tenant:status:<id>` after commit, and every other service only
 * reads that key. Its own `pg.Client` is not the request pool — a `LISTEN`
 * connection is held open for the life of the process.
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  controllers: [TenantStatusController],
  providers: [
    TenantStatusService,
    TenantStatusListener,
    {
      provide: TENANT_STATUS_LISTEN_CLIENT,
      useFactory: (config: ConfigService) => () => new Client({ connectionString: config.get<string>('DATABASE_APP_URL') }),
      inject: [ConfigService],
    },
  ],
})
export class StatusModule {}
