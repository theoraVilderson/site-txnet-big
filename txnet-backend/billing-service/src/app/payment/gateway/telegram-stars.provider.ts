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
 * Telegram Stars (F-104-k, D-32) — paid inside the chat, settled by the
 * messenger, never by a bank.
 *
 * Nothing here calls anybody. The invoice is sent by `bot-service` through
 * `messenger` (F-104-l), with the bot's token, which `billing` never holds; the
 * payment settles when the bot relays `pre_checkout_query` and
 * `successful_payment` to `deposit/in-chat/*` (`DepositInChatService`). So
 * every call the port has for a bank refuses: `start` does not mint for an
 * `in_chat` driver, and reconciliation's `inquire` hearing `unavailable` is
 * what walks an approved payment whose `paid` never came up the retry ladder
 * to a person (F-092-y).
 *
 * Priced in whole Stars (`XTR`, no minor unit). The gateway's `staticRate` is a
 * Star's **USD value** (F-104-e), the inverse of the calculator's rate, which
 * `staticRateIsChargeUnitValue` tells `priceDeposit`; `priceAtGateway` rounds
 * the charge up, so a fraction of a Star is a whole one.
 */
export class TelegramStarsProvider implements PaymentProvider {
  readonly name = PaymentProviderName.telegram_stars;
  readonly chargeCurrency = 'XTR';
  readonly chargeDecimals = 0;
  // Telegram keeps nothing unverified for us to lose: the payment is final when it arrives.
  readonly verifyWindowSec = null;
  readonly settlement = 'in_chat' as const;
  readonly chatPlatform = 'telegram' as const;
  readonly staticRateIsChargeUnitValue = true;

  async request(): Promise<PaymentRequestResult> {
    throw new GatewayFailure(this.name, 'invalid_request', null, 'an in-chat payment is invoiced by the bot, not minted');
  }

  async verify(): Promise<PaymentVerifyResult> {
    throw new GatewayFailure(this.name, 'unavailable', null, 'Telegram Stars has no verify: the bot relays successful_payment');
  }

  async inquire(): Promise<PaymentInquiryResult> {
    throw new GatewayFailure(this.name, 'unavailable', null, 'Telegram Stars has no inquiry: the bot relays successful_payment');
  }

  async quoteFee(): Promise<FeeQuote> {
    throw new GatewayFailure(this.name, 'invalid_request', null, 'Telegram Stars quotes no fee');
  }
}
