import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProviderName } from '@prisma/client';

import type { EnvConfig } from '../../config/env.validation';
import { PaymentProvider, ProviderNotSupported } from './payment-provider';
import { ZarinpalProvider } from './zarinpal.provider';

/**
 * Which driver answers a gateway row's `providerName` (F-092-f). Replaces
 * legacy `PaymentFactory`, which also read the settings row and its plaintext
 * merchant id: here a driver is chosen by name only, and the merchant comes
 * from `GatewayMerchant` per call.
 *
 * `PaymentProviderName` has members with no driver yet (`idpay`,
 * `nowpayments`, `stripe`, and D-32's `oxapay`, `airwallex`, `telegram_stars`,
 * `bale`); asking for one is `ProviderNotSupported`, never a
 * fallback to another gateway.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: ReadonlyMap<PaymentProviderName, PaymentProvider>;

  constructor(config: ConfigService<EnvConfig, true>) {
    const sandbox = config.get('PAYMENT_GATEWAY_SANDBOX', { infer: true });
    this.providers = new Map<PaymentProviderName, PaymentProvider>([
      [PaymentProviderName.zarinpal, new ZarinpalProvider({ sandbox })],
    ]);
    // A webhook driver that cannot check a signature would make the webhook
    // door answer 404 for a gateway that is supposed to settle there (ADR-0051).
    for (const provider of this.providers.values()) {
      if (provider.settlement === 'webhook' && !provider.verifyWebhook) {
        throw new Error(`payment provider '${provider.name}' settles by webhook but has no verifyWebhook`);
      }
    }
  }

  /** A gateway whose provider has no driver cannot take a payment, so a selector hides it. */
  has(name: PaymentProviderName): boolean {
    return this.providers.has(name);
  }

  get(name: PaymentProviderName): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new ProviderNotSupported(name);
    return provider;
  }
}
