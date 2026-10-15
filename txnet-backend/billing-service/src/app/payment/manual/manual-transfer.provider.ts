import { PaymentProviderName } from '@prisma/client';

import { FeeQuote, GatewayFailure, PaymentInquiryResult, PaymentProvider, PaymentRequestResult, PaymentVerifyResult } from '../gateway/payment-provider';

const NO_CURRENCY = 'a manual gateway charges in its destination currency: read chargeOf(), never the driver';

/**
 * The driver a `manual_transfer` gateway answers to (F-803-d, D-60). The payer
 * moves the money to the seller's card or wallet and a person confirms it
 * against the proof (F-805-a), so nothing here calls anybody: every bank
 * operation refuses, and there is no unverified list — which is what keeps a
 * manual payment, open and without an authority by design, out of
 * reconciliation's way (F-092-ad).
 *
 * Registered so every path that looks a driver up by the payment's provider
 * finds one. It has **no charge currency of its own**: a card charges rials, a
 * wallet its asset, both read from the gateway's destination by `chargeOf`
 * (`manual-transfer.ts`). Asking the driver throws, so a caller that forgot is
 * a loud bug rather than a payment priced in the wrong currency.
 */
export class ManualTransferProvider implements PaymentProvider {
  readonly name = PaymentProviderName.manual_transfer;
  // Nothing is held at a gateway that could be returned unverified.
  readonly verifyWindowSec = null;
  readonly settlement = 'manual' as const;

  get chargeCurrency(): string {
    throw new Error(NO_CURRENCY);
  }

  get chargeDecimals(): number {
    throw new Error(NO_CURRENCY);
  }

  async request(): Promise<PaymentRequestResult> {
    throw new GatewayFailure(this.name, 'invalid_request', null, 'a manual transfer is paid by the payer, not minted');
  }

  async verify(): Promise<PaymentVerifyResult> {
    throw new GatewayFailure(this.name, 'unavailable', null, 'a manual transfer is confirmed by a person, not verified');
  }

  async inquire(): Promise<PaymentInquiryResult> {
    throw new GatewayFailure(this.name, 'unavailable', null, 'a manual transfer has no gateway to ask');
  }

  async quoteFee(): Promise<FeeQuote> {
    throw new GatewayFailure(this.name, 'invalid_request', null, 'a manual gateway quotes no fee (F-803-c refuses an automatic fee)');
  }
}
