import type { GatewaySecretName } from "@/lib/billing-api";

/**
 * What each provider asks an operator for (F-104-f, D-32) — the one map the
 * wizard, the edit screen and the list read, so a driver row never has to
 * touch this app. It mirrors billing's `payment/gateway/provider-fields.ts`,
 * which is the rule; this is how the rule is asked for.
 *
 * `slot` is where a value is sent (a vault slot, or the gateway's static rate);
 * `label` names the provider's own word for it, under `gateways.fields.*`.
 */

export type ProviderFieldLabel =
  | "merchantId"
  | "merchantKey"
  | "clientId"
  | "apiKey"
  | "secretKey"
  | "webhookSecret"
  | "ipnSecret"
  | "providerToken"
  | "starRate";

export type ProviderField =
  | { slot: GatewaySecretName; label: ProviderFieldLabel }
  | { slot: "staticRate"; label: ProviderFieldLabel };

export const PROVIDER_FIELDS = {
  zarinpal: [{ slot: "merchantId", label: "merchantId" }],
  idpay: [{ slot: "merchantId", label: "apiKey" }],
  nowpayments: [
    { slot: "secretKey", label: "apiKey" },
    { slot: "webhookSecret", label: "ipnSecret" },
  ],
  stripe: [
    { slot: "secretKey", label: "secretKey" },
    { slot: "webhookSecret", label: "webhookSecret" },
  ],
  oxapay: [{ slot: "merchantId", label: "merchantKey" }],
  airwallex: [
    { slot: "merchantId", label: "clientId" },
    { slot: "secretKey", label: "apiKey" },
    { slot: "webhookSecret", label: "webhookSecret" },
  ],
  telegram_stars: [{ slot: "staticRate", label: "starRate" }],
  bale: [{ slot: "secretKey", label: "providerToken" }],
} as const satisfies Record<string, readonly ProviderField[]>;

export type Provider = keyof typeof PROVIDER_FIELDS;

/** A provider this app does not know yet (a row newer than the panel) is asked for the two original secrets. */
const UNKNOWN: readonly ProviderField[] = [
  { slot: "merchantId", label: "merchantId" },
  { slot: "secretKey", label: "secretKey" },
];

export function providerFields(provider: string): readonly ProviderField[] {
  return provider in PROVIDER_FIELDS ? PROVIDER_FIELDS[provider as Provider] : provider ? UNKNOWN : [];
}

export const secretFields = (provider: string) =>
  providerFields(provider).filter((f): f is { slot: GatewaySecretName; label: ProviderFieldLabel } => f.slot !== "staticRate");

export const takesStaticRate = (provider: string) => providerFields(provider).some((f) => f.slot === "staticRate");
