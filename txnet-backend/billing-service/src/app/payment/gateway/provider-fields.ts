import { PaymentProviderName, TenantCredentialKind } from '@prisma/client';

/** The secrets a gateway can carry, each its own vault kind under the gateway row's label (F-102-a, F-104-c). */
export const GATEWAY_SECRET_NAMES = ['merchantId', 'secretKey', 'webhookSecret'] as const;
export type GatewaySecretName = (typeof GATEWAY_SECRET_NAMES)[number];

/** The vault kind each secret is stored under — `auth-service` writes by the same names (F-102-a). */
export const SECRET_KIND: Record<GatewaySecretName, TenantCredentialKind> = {
  merchantId: TenantCredentialKind.gateway_merchant_id,
  secretKey: TenantCredentialKind.gateway_secret_key,
  webhookSecret: TenantCredentialKind.webhook_secret,
};

export type ProviderFields = {
  /** The secrets a gateway of this provider needs to take a payment, in `GATEWAY_SECRET_NAMES` order. */
  secrets: readonly GatewaySecretName[];
  /** The gateway is priced by its own `staticRate` alone, and the live rate is off (a Star's USD value, D-32). */
  staticRateRequired: boolean;
  /**
   * The stored secret a webhook from this provider is signed with — usually
   * `webhookSecret`, but OxaPay signs with its merchant key (F-104-i). `null`
   * for a provider that posts no webhook.
   */
  webhookSignedWith: GatewaySecretName | null;
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
  zarinpal: { secrets: ['merchantId'], staticRateRequired: false, webhookSignedWith: null },
  idpay: { secrets: ['merchantId'], staticRateRequired: false, webhookSignedWith: null },
  stripe: { secrets: ['secretKey', 'webhookSecret'], staticRateRequired: false, webhookSignedWith: 'webhookSecret' },
  nowpayments: { secrets: ['secretKey', 'webhookSecret'], staticRateRequired: false, webhookSignedWith: 'webhookSecret' },
  oxapay: { secrets: ['merchantId'], staticRateRequired: false, webhookSignedWith: 'merchantId' },
  airwallex: { secrets: ['merchantId', 'secretKey', 'webhookSecret'], staticRateRequired: false, webhookSignedWith: 'webhookSecret' },
  telegram_stars: { secrets: [], staticRateRequired: true, webhookSignedWith: null },
  bale: { secrets: ['secretKey'], staticRateRequired: false, webhookSignedWith: null },
};
