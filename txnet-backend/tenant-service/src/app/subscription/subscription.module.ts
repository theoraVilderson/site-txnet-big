import { Module } from '@nestjs/common';
import { ResellerAccess, TenantBillingLedger } from '@txnet-backend/shared-core';

import { TenantRenewalInternalController } from '../renewal/tenant-renewal-internal.controller';
import { TenantRenewalService } from '../renewal/tenant-renewal.service';
import { ResellerSubscriptionChangeController, TenantSubscriptionController } from './tenant-subscription.controller';
import { TenantSubscriptionService } from './tenant-subscription.service';

/**
 * Which package each reseller is on and until when (F-018-e), the platform
 * owner's extra time to pay (F-019-g) and the renewal that charges the billing
 * wallet (F-019-c) — moved out of `auth-service` with F-018-v (ADR-0058).
 *
 * Renewal ships in the same module as the subscription it renews: the two
 * share the deadline (`renewalDeadline`) and the lock order, and a module
 * boundary between them would only hide that.
 *
 * `PrismaModule` is `@Global`, so the two pools come from there;
 * `TenantBillingLedger` is the ledger writer `billing-service` uses on the same
 * tables (ADR-0056).
 */
@Module({
  controllers: [TenantSubscriptionController, ResellerSubscriptionChangeController, TenantRenewalInternalController],
  providers: [TenantSubscriptionService, TenantRenewalService, TenantBillingLedger, ResellerAccess],
})
export class SubscriptionModule {}
