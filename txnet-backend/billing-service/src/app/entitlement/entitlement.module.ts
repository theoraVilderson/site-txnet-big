import { Module } from '@nestjs/common';
import { KekService } from '@txnet-backend/shared-core';

import { TrafficModule } from '../traffic/traffic.module';
import { WalletModule } from '../wallet/wallet.module';
import { GrantDeliveryService } from './delivery';
import { EntitlementInternalController } from './entitlement-internal.controller';
import { GrantService } from './grant';
import { GrantTokenSeal } from './grant-token-seal';
import { GrantPurgeService } from './purge';

/**
 * Entitlement, as a module inside billing-service (ADR-0049). In-process only:
 * a coupon (F-502-l) or a purchase issues a Grant inside its own transaction.
 *
 * Two routes, and neither faces a user: the purge sweep (F-027-y), asked
 * hourly, and the delivery sweep (F-111-d), asked every minute, both by
 * `worker-service` over the internal seam. ADR-0027 is why the clocks are not
 * here — background work does not run inside a request-serving process.
 * Delivery hands a network Grant to group fulfilment and a refund to the
 * wallet, hence the two imports. `KekService` is for the sealed subscription
 * token (ADR-0085): the same KEK file the gateway module reads.
 */
@Module({
  imports: [TrafficModule, WalletModule],
  controllers: [EntitlementInternalController],
  providers: [KekService, GrantTokenSeal, GrantService, GrantPurgeService, GrantDeliveryService],
  exports: [GrantService, GrantPurgeService],
})
export class EntitlementModule {}
