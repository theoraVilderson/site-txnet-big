/** Which table a gateway row is in: a tenant's `tenant_gateway_config`, or the platform brand's `payment_gateway`. */
export const GATEWAY_CREDENTIAL_SOURCES = ['tenant', 'platform'] as const;
export type GatewayCredentialSource = (typeof GATEWAY_CREDENTIAL_SOURCES)[number];

/**
 * The vault label of one gateway's secrets: `gateway:<source>:<gatewayId>`.
 *
 * Spelled once, here, because two processes must agree on it byte for byte:
 * `tenant-service` writes a gateway's merchant id and secret key under it
 * (F-102-a) and `billing-service` reads them back under it (F-092-t). A second
 * copy that drifted would store a secret no payment ever finds, and the gateway
 * would silently drop off the top-up page (F-092-u).
 *
 * The label names the gateway **row**, not the provider (D-26): every gateway
 * pays into its own account.
 */
export const gatewayCredentialLabel = (source: GatewayCredentialSource, gatewayId: string) =>
  `gateway:${source}:${gatewayId}`;
