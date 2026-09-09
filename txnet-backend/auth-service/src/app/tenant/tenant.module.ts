import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TenantCacheService } from './tenant-cache.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantGuard } from './tenant.guard';

/**
 * `tenant`'s first module. It has no controller: nothing outside this process
 * asks for a tenant by name yet — the resolver is consumed by the edge
 * middleware and, from F-061-b, by `register`.
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
 * `PrismaModule` and `RedisModule` are both `@Global`, so neither is imported
 * here.
 */
@Module({
  providers: [
    TenantCacheService,
    TenantResolverService,
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
  exports: [TenantResolverService, TenantCacheService],
})
export class TenantModule {}
