import { Module } from '@nestjs/common';

import { EntitlementInternalController } from './entitlement-internal.controller';
import { GrantService } from './grant';
import { GrantPurgeService } from './purge';

/**
 * Entitlement, as a module inside billing-service (ADR-0049). In-process only:
 * a coupon (F-502-l) or a purchase issues a Grant inside its own transaction.
 *
 * One route, and it faces no user: the purge sweep (F-027-y), asked hourly by
 * `worker-service` over the internal seam. ADR-0027 is why the clock is not
 * here — background work does not run inside a request-serving process.
 */
@Module({
  controllers: [EntitlementInternalController],
  providers: [GrantService, GrantPurgeService],
  exports: [GrantService, GrantPurgeService],
})
export class EntitlementModule {}
