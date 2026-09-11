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
 * `nowpayments`, `stripe`); asking for one is `ProviderNotSupported`, never a
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
  }

  get(name: PaymentProviderName): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new ProviderNotSupported(name);
    return provider;
  }
}
