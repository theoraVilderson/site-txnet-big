import { Module } from '@nestjs/common';

import { GrantService } from './grant';

/**
 * Entitlement, as a module inside billing-service (ADR-0049). In-process only:
 * a coupon (F-502-l) or a purchase issues a Grant inside its own transaction.
 * No route until a row needs one.
 */
@Module({
  providers: [GrantService],
  exports: [GrantService],
})
export class EntitlementModule {}
