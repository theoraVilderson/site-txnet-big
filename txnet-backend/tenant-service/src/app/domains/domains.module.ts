import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { DOMAIN_LOOKUP, NodeDomainLookup } from './domain-lookup';
import { DomainProbeSocket } from './domain-probe-socket';
import { CloudflareEdgeProvider } from './edge/cloudflare-edge-provider';
import { EDGE_PROVIDER, EdgeProvider, UnconfiguredEdgeProvider } from './edge/edge-provider';
import { ServesPanelController } from './serves-panel.controller';
import { TenantDomainController } from './tenant-domain.controller';
import { DomainProbeController, TenantDomainInternalController } from './tenant-domain-internal.controller';
import { TenantDomainService } from './tenant-domain.service';

/** Cloudflare when its zone and token are set (ADR-0129 (5)); otherwise every edge call refuses. */
const edgeProvider = (config: ConfigService): EdgeProvider => {
  const token = config.get<string>('CLOUDFLARE_API_TOKEN', '');
  const zone = config.get<string>('CLOUDFLARE_ZONE_ID', '');
  return token && zone ? new CloudflareEdgeProvider(token, zone) : new UnconfiguredEdgeProvider();
};

/**
 * A reseller's custom domains and their proof (F-018-i).
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  controllers: [TenantDomainController, TenantDomainInternalController, DomainProbeController, ServesPanelController],
  providers: [
    TenantDomainService,
    DomainProbeSocket,
    ResellerAccess,
    { provide: DOMAIN_LOOKUP, useClass: NodeDomainLookup },
    { provide: EDGE_PROVIDER, useFactory: edgeProvider, inject: [ConfigService] },
  ],
})
export class DomainsModule {}
