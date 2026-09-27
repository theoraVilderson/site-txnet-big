import { Module } from '@nestjs/common';
import { KekService } from '@txnet-backend/shared-core';

import { TrafficModule } from '../traffic/traffic.module';
import { WalletModule } from '../wallet/wallet.module';
import { GrantDeliveryService } from './delivery';
import { EntitlementInternalController } from './entitlement-internal.controller';
import { GrantService } from './grant';
import { GrantTokenSeal } from './grant-token-seal';
import { GrantPurgeService } from './purge';
import { GrantPurgeNoticeService } from './purge-notice';
import { GrantUnusedNoticeService } from './unused-notice';
import { GrantEndNoticeService } from './end-notice';
import { GrantIdleNoticeService } from './idle-notice';

/**
 * Entitlement, as a module inside billing-service (ADR-0049). In-process only:
 * a coupon (F-502-l) or a purchase issues a Grant inside its own transaction.
 *
 * Five sweeps, and none faces a user: purge (F-027-y), "not connected yet?"
 * (F-601-c), time thresholds (F-601-e) and "trouble connecting?" (F-601-l),
 * asked hourly, and delivery
 * (F-111-d), every minute, all by
 * `worker-service` over the internal seam. ADR-0027 is why the clocks are not
 * here — background work does not run inside a request-serving process.
 * Delivery hands a network Grant to group fulfilment and a refund to the
 * wallet, hence the two imports. `KekService` is for the sealed subscription
 * token (ADR-0085): the same KEK file the gateway module reads.
 */
@Module({
  imports: [TrafficModule, WalletModule],
  controllers: [EntitlementInternalController],
  providers: [KekService, GrantTokenSeal, GrantService, GrantPurgeService, GrantDeliveryService, GrantUnusedNoticeService, GrantEndNoticeService, GrantPurgeNoticeService, GrantIdleNoticeService],
  exports: [GrantService, GrantPurgeService],
})
export class EntitlementModule {}
