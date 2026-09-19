import { Module } from '@nestjs/common';
import { TenantBillingLedger } from '@txnet-backend/shared-core';

import {
  TenantBillingAdminController,
  TenantBillingPermissionGuard,
  TenantBillingReadGuard,
} from './tenant-billing-admin.controller';
import { TenantBillingAdminService } from './tenant-billing-admin.service';
import { DepositModule } from '../payment/deposit/deposit.module';
import { TenantTopupController } from './tenant-topup.controller';
import { TenantTopupService } from './tenant-topup.service';
import { TenantWalletController } from './tenant-wallet.controller';
import { TenantWalletService } from './tenant-wallet.service';

/**
 * A reseller's billing wallet with the platform (F-019-a, D-41) — the tenant
 * unit's ledger, served by billing-service beside the other money surfaces.
 * `PrismaModule` is `@Global()`. A reseller's top-up (F-019-b) starts through
 * `DepositModule`, which settles it with its own `TenantBillingLedger`; the
 * reseller reads its balance and history through `TenantWalletService` (F-019-d),
 * and the platform owner reads one reseller's through the admin service (F-019-j).
 */
@Module({
  imports: [DepositModule],
  controllers: [TenantBillingAdminController, TenantTopupController, TenantWalletController],
  providers: [TenantBillingLedger, TenantBillingAdminService, TenantBillingPermissionGuard, TenantBillingReadGuard, TenantTopupService, TenantWalletService],
  exports: [TenantBillingLedger],
})
export class TenantBillingModule {}
