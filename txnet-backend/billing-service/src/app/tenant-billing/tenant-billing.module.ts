import { Module } from '@nestjs/common';
import { TenantBillingLedger } from '@txnet-backend/shared-core';

import { TenantBillingAdminController, TenantBillingPermissionGuard } from './tenant-billing-admin.controller';
import { TenantBillingAdminService } from './tenant-billing-admin.service';
import { DepositModule } from '../payment/deposit/deposit.module';
import { TenantTopupController } from './tenant-topup.controller';
import { TenantTopupService } from './tenant-topup.service';

/**
 * A reseller's billing wallet with the platform (F-019-a, D-41) — the tenant
 * unit's ledger, served by billing-service beside the other money surfaces.
 * `PrismaModule` is `@Global()`. A reseller's top-up (F-019-b) starts through
 * `DepositModule`, which settles it with its own `TenantBillingLedger`.
 */
@Module({
  imports: [DepositModule],
  controllers: [TenantBillingAdminController, TenantTopupController],
  providers: [TenantBillingLedger, TenantBillingAdminService, TenantBillingPermissionGuard, TenantTopupService],
  exports: [TenantBillingLedger],
})
export class TenantBillingModule {}
