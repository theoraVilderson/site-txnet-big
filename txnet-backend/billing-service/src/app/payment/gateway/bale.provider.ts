import { PaymentProviderName } from '@prisma/client';

import {
  FeeQuote,
  GatewayFailure,
  PaymentInquiryResult,
  PaymentProvider,
  PaymentRequestResult,
  PaymentVerifyResult,
} from './payment-provider';

/**
 * Bale's wallet (F-104-n, D-32) — paid inside a Bale chat, settled by the
 * messenger, never by a bank. The same shape as `TelegramStarsProvider`.
 *
 * Nothing here calls anybody. `bot-service` sends the invoice through
 * `messenger` (F-104-l) and relays `pre_checkout_query` / `successful_payment`
 * to `deposit/in-chat/*`. The one thing Bale needs that Stars does not is the
 * wallet's provider token: it is the gateway's `secretKey` vault slot
 * (`provider-fields.ts`), which `start` reads and hands to the bot in the
 * invoice it answers — the bot, not billing, sends it.
 *
 * Priced in whole rials (`IRR`) at the gateway's live or static rate, exactly
 * as Zarinpal is (F-092-c): Bale has no `currency` parameter and takes rials only.
 */
export class BaleProvider implements PaymentProvider {
  readonly name = PaymentProviderName.bale;
  readonly chargeCurrency = 'IRR';
  readonly chargeDecimals = 0;
  // The payment is final when Bale reports it: nothing waits on our verify.
  readonly verifyWindowSec = null;
  readonly settlement = 'in_chat' as const;
  readonly chatPlatform = 'bale' as const;

  async request(): Promise<PaymentRequestResult> {
    throw new GatewayFailure(this.name, 'invalid_request', null, 'an in-chat payment is invoiced by the bot, not minted');
  }

  async verify(): Promise<PaymentVerifyResult> {
    throw new GatewayFailure(this.name, 'unavailable', null, 'Bale has no verify: the bot relays successful_payment');
  }

  async inquire(): Promise<PaymentInquiryResult> {
    throw new GatewayFailure(this.name, 'unavailable', null, 'Bale has no inquiry: the bot relays successful_payment');
  }

  async quoteFee(): Promise<FeeQuote> {
    throw new GatewayFailure(this.name, 'invalid_request', null, 'Bale quotes no fee');
  }
}
