import { Module } from '@nestjs/common';
import { TenantBillingLedger } from '@txnet-backend/shared-core';

import { TenantBillingAdminController, TenantBillingPermissionGuard } from './tenant-billing-admin.controller';
import { TenantBillingAdminService } from './tenant-billing-admin.service';

/**
 * A reseller's billing wallet with the platform (F-019-a, D-41) — the tenant
 * unit's ledger, served by billing-service beside the other money surfaces.
 * `PrismaModule` is `@Global()`. Exports the ledger for top-up (F-019-b).
 */
@Module({
  controllers: [TenantBillingAdminController],
  providers: [TenantBillingLedger, TenantBillingAdminService, TenantBillingPermissionGuard],
  exports: [TenantBillingLedger],
})
export class TenantBillingModule {}
