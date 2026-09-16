import { PaymentProviderName } from '@prisma/client';

/** The secrets a gateway can carry, each its own vault kind under the gateway row's label (F-102-a, F-104-c). */
export const GATEWAY_SECRET_NAMES = ['merchantId', 'secretKey', 'webhookSecret'] as const;
export type GatewaySecretName = (typeof GATEWAY_SECRET_NAMES)[number];

export type ProviderFields = {
  /** The secrets a gateway of this provider needs to take a payment, in `GATEWAY_SECRET_NAMES` order. */
  secrets: readonly GatewaySecretName[];
  /** The gateway is priced by its own `staticRate` alone, and the live rate is off (a Star's USD value, D-32). */
  staticRateRequired: boolean;
};

/**
 * What each provider asks of a gateway (F-104-e, D-32). Exhaustive, so a new
 * provider does not compile until someone says what it needs.
 *
 * A missing **secret** is never refused: a gateway may be created and switched
 * on without its secrets, and the answer's `missingSecrets` is the heads-up
 * (the user's call, 2026-09-16). A missing required **setting** is refused.
 *
 * Which slot a provider's own credential lands in: an account identifier or a
 * key the provider calls a merchant key → `merchantId`; an API key or token →
 * `secretKey`; what it signs posts with → `webhookSecret`.
 */
export const PROVIDER_FIELDS: Record<PaymentProviderName, ProviderFields> = {
  zarinpal: { secrets: ['merchantId'], staticRateRequired: false },
  idpay: { secrets: ['merchantId'], staticRateRequired: false },
  stripe: { secrets: ['secretKey', 'webhookSecret'], staticRateRequired: false },
  nowpayments: { secrets: ['secretKey', 'webhookSecret'], staticRateRequired: false },
  oxapay: { secrets: ['merchantId'], staticRateRequired: false },
  airwallex: { secrets: ['merchantId', 'secretKey', 'webhookSecret'], staticRateRequired: false },
  telegram_stars: { secrets: [], staticRateRequired: true },
  bale: { secrets: ['secretKey'], staticRateRequired: false },
};
