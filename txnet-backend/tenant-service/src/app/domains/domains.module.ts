import { Module } from '@nestjs/common';

import { DOMAIN_LOOKUP, NodeDomainLookup } from './domain-lookup';
import { TenantDomainController } from './tenant-domain.controller';
import { DomainProbeController, TenantDomainInternalController } from './tenant-domain-internal.controller';
import { TenantDomainService } from './tenant-domain.service';

/**
 * A reseller's custom domains and their proof (F-018-i).
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  controllers: [TenantDomainController, TenantDomainInternalController, DomainProbeController],
  providers: [TenantDomainService, { provide: DOMAIN_LOOKUP, useClass: NodeDomainLookup }],
})
export class DomainsModule {}
