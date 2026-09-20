import { Module } from '@nestjs/common';
import { TenantBillingLedger } from '@txnet-backend/shared-core';

import { LocaleModule } from '../../locale/locale.module';
import { WalletModule } from '../../wallet/wallet.module';
import { CouponModule } from '../coupon/coupon.module';
import { GatewayModule } from '../gateway/gateway.module';
import { FxRateReader } from '../pricing/fx-rate.reader';
import { DepositAbandonService } from './deposit-abandon.service';
import { DepositCallbackController } from './deposit-callback.controller';
import { DepositCallbackService } from './deposit-callback.service';
import { DepositController } from './deposit.controller';
import { DepositExpiryService } from './deposit-expiry.service';
import { DepositFollowOnService } from './deposit-follow-on.service';
import { DepositInChatController } from './deposit-in-chat.controller';
import { DepositInChatService } from './deposit-in-chat.service';
import { DepositReconciliationService } from './deposit-reconciliation.service';
import { DepositSettlementService } from './deposit-settlement';
import { DepositInternalController } from './deposit-internal.controller';
import { DepositQuoteService } from './deposit-quote.service';
import { DepositStartService } from './deposit-start.service';
import { InvoiceLinkClient } from './invoice-link.client';
import { DepositWebhookController } from './deposit-webhook.controller';
import { DepositWebhookService } from './deposit-webhook.service';
import { ManualConfirmController } from './manual-confirm.controller';
import { ManualConfirmService } from './manual-confirm.service';

/**
 * The top-up page (F-092-o, F-092-i): the gateway list, the quote, and starting
 * the payment the quote described, and settling it when the bank sends the
 * payer back (F-092-j). `WalletModule` serves both ends: the free path credits
 * the wallet itself because no gateway will ever call back about it, and the
 * callback credits every other payment.
 *
 * `DepositCallbackController` is a second controller rather than a route on the
 * first because it is the only **public** one on this service — see its own
 * doc comment, and `app.module.ts` for the middleware that stands in for the
 * gate on it.
 *
 * `DepositWebhookController` is the second public one (F-104-b, ADR-0051): a
 * provider's server, not a browser, with the gateway in the path.
 *
 * `DepositInternalController` is a third, for the mirror-image reason: it is
 * the only **service-to-service** one, reached by `worker-service`'s expiry
 * tick (F-092-k) and its reconciliation tick (F-092-l), and by nothing from
 * the edge at all.
 *
 * `DepositInChatController` is service-to-service too (F-104-k, F-104-ab):
 * the bot relays a messenger's payment with the sender's id, and the payment,
 * not a chat session, says whose it is.
 */
@Module({
  imports: [LocaleModule, CouponModule, GatewayModule, WalletModule],
  controllers: [DepositController, DepositInChatController, DepositCallbackController, DepositWebhookController, DepositInternalController, ManualConfirmController],
  providers: [DepositQuoteService, DepositStartService, DepositAbandonService, DepositCallbackService, DepositSettlementService, DepositFollowOnService, DepositExpiryService, DepositReconciliationService, ManualConfirmService, DepositWebhookService, DepositInChatService, FxRateReader, InvoiceLinkClient, TenantBillingLedger],
  exports: [DepositQuoteService, DepositStartService, DepositCallbackService, DepositExpiryService, DepositReconciliationService],
})
export class DepositModule {}
