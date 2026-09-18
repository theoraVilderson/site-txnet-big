import { Module } from '@nestjs/common';
import { TenantBillingLedger, WalletLedgerService } from '@txnet-backend/shared-core';

import { ResellerPurchaseController } from './reseller-purchase.controller';
import { ResellerPurchaseService } from './reseller-purchase.service';

/**
 * A platform user buys a reseller package (F-019-h, ADR-0061).
 *
 * Both ledgers are `shared-core`'s: the buyer's wallet (`WalletLedgerService`,
 * which `billing-service` also writes) and the new reseller's billing wallet
 * (`TenantBillingLedger`), in the one transaction that creates the reseller.
 * `PrismaModule` and `RedisModule` are `@Global`.
 */
@Module({
  controllers: [ResellerPurchaseController],
  providers: [ResellerPurchaseService, WalletLedgerService, TenantBillingLedger],
})
export class PurchaseModule {}
