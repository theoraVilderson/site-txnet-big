import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { EntitlementModule } from '../../entitlement/entitlement.module';
import { TrafficModule } from '../../traffic/traffic.module';
import { WalletModule } from '../../wallet/wallet.module';
import { GiftController } from './gift.controller';
import { GrantListController } from './grant-list.controller';
import { GrantTokenController } from './grant-token.controller';
import { GiftRedemptionService } from './gift-redemption.service';
import { ResellerUserGrantsController } from './reseller-user-grants.controller';
import { ResellerUserGrantsService } from './reseller-user-grants.service';
import { SubscriptionLinkService } from './subscription-link.service';

/**
 * The gift-code box (F-092-m). It needs no coupon provider: the discount engine
 * refuses a `wallet_credit` coupon by design, so the gates are the migration's
 * function and the money moves through `WalletLedgerService` — or, for a
 * free-service code, the Grant through `GrantService` (F-502-l-b) — which is
 * also what lists the Grants a user has (F-502-r) and, through
 * `SubscriptionLinkService`, answers and resets their `/sub` links (F-114-e-b).
 * The same reads, with a Grant's configs and usage from `TrafficModule`, are
 * answered to a reseller's admin for one of its users (F-311-f).
 */
@Module({
  imports: [WalletModule, EntitlementModule, TrafficModule],
  controllers: [GiftController, GrantTokenController, GrantListController, ResellerUserGrantsController],
  providers: [GiftRedemptionService, SubscriptionLinkService, ResellerUserGrantsService, ResellerAccess],
  exports: [GiftRedemptionService],
})
export class GiftModule {}
