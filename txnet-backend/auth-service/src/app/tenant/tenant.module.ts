import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TENANT_STATUS_STORE, TenantBillingLedger, TenantStatusGuard } from '@txnet-backend/shared-core';
import { Client } from 'pg';
import { RedisService } from '../redis/redis.service';
import { TenantCacheService } from './tenant-cache.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantGuard } from './tenant.guard';
import { TenantAdminController } from './admin/tenant-admin.controller';
import { TenantAdminService } from './admin/tenant-admin.service';
import { TenantSubscriptionController } from './subscription/tenant-subscription.controller';
import { TenantSubscriptionService } from './subscription/tenant-subscription.service';
import { TenantStatusController } from './status/tenant-status.controller';
import { TenantStatusService } from './status/tenant-status.service';
import { TENANT_STATUS_LISTEN_CLIENT, TenantStatusListener } from './status/tenant-status.listener';
import { TenantRenewalInternalController } from './renewal/tenant-renewal-internal.controller';
import { TenantRenewalService } from './renewal/tenant-renewal.service';

/**
 * `tenant`'s first module. Its controllers are the platform owner's reseller
 * administration (F-018-c) and which package each reseller is on (F-018-e) — the
 * packages themselves are `tenant-service`'s since F-018-u (ADR-0058); the resolver is consumed by the edge middleware
 * and, from F-061-b, by `register`.
 *
 * `TenantGuard` is global rather than a route decorator: a request that
 * resolves to no tenant, or whose session and surface disagree, must be
 * refused everywhere — including on the routes whose authors never thought
 * about tenancy (ADR-0024 decision 4, ADR-0025).
 *
 * `TenantCacheService` is exported alongside the resolver because the code
 * that will invalidate it is not the code that reads it: domain
 * administration (F-018) creates, verifies, switches and deletes
 * `tenant_domain` rows, and each of those must retract the mapping without
 * needing the resolver at all (ADR-0025).
 *
 * `TenantStatusGuard` runs after it (F-018-f): once the tenant is known, its
 * status decides what the route may do, from the key `TenantStatusListener`
 * writes.
 *
 * `PrismaModule` and `RedisModule` are both `@Global`, so neither is imported
 * here.
 */
@Module({
  controllers: [TenantAdminController, TenantSubscriptionController, TenantStatusController, TenantRenewalInternalController],
  providers: [
    TenantAdminService,
    TenantSubscriptionService,
    TenantStatusService,
    TenantStatusListener,
    TenantRenewalService,
    TenantBillingLedger,
    {
      provide: TENANT_STATUS_LISTEN_CLIENT,
      useFactory: (config: ConfigService) => () =>
        new Client({ connectionString: config.get<string>('DATABASE_APP_URL') }),
      inject: [ConfigService],
    },
    TenantCacheService,
    TenantResolverService,
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: TENANT_STATUS_STORE, useExisting: RedisService },
    { provide: APP_GUARD, useClass: TenantStatusGuard },
  ],
  exports: [TenantResolverService, TenantCacheService],
})
export class TenantModule {}
