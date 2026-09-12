import { Injectable } from '@nestjs/common';
import { PaymentProviderName, TenantCredentialKind, TenantCredentialStatus } from '@prisma/client';
import { CredentialUnavailable, CredentialVaultService } from '@txnet-backend/shared-core';

import type { GatewayCredentials } from './payment-provider';

/** Which table a gateway row is in: a tenant's `tenant_gateway_config`, or the platform brand's `payment_gateway`. */
export type GatewaySource = 'tenant' | 'platform';

/** One gateway row, as the vault is asked about it. */
export type MerchantGatewayRef = {
  /** The tenant whose vault holds it — for a platform gateway, the `platform_owner` tenant. */
  tenantId: string;
  source: GatewaySource;
  gatewayId: string;
  providerName: PaymentProviderName;
};

/**
 * The vault label of one gateway's merchant id: `gateway:<source>:<gatewayId>`,
 * in the shape the bot's `bot:<platform>:<username>` labels already use.
 */
export const merchantLabel = (source: GatewaySource, gatewayId: string) => `gateway:${source}:${gatewayId}`;

/**
 * A gateway's merchant id, from its tenant's vault (F-092-f, ADR-0006,
 * ADR-0026, ADR-0039) — never from `tenant_gateway_config.merchantIdEncrypted`
 * or `payment_gateway.merchantId`, which are deprecated and never read.
 *
 * **Every gateway pays into its own account** (D-26). The credential is
 * `gateway_merchant_id` labelled with the gateway **row**, not the provider:
 * two gateways of one provider under one tenant — the platform owner's
 * platform and own gateways, or two platform ones with different fees — hold
 * two merchant ids. There is no fallback to a provider-wide label, because a
 * fallback is exactly the shared account D-26 rejected. The cost is that a
 * recreated gateway row has a new id, so its merchant id is stored again.
 *
 * Every call is a `vault.use`, so every call writes a
 * `tenant_credential_access` row naming the driver and, when there is one, the
 * user the payment is for. The value is handed to one driver call and not kept.
 *
 * `CredentialUnavailable` passes through: a gateway with no merchant id in the
 * vault cannot take a payment, and the route decides what the user is told.
 * Such a gateway is also kept off the top-up page, which is what
 * `configuredLabels` and `requireConfigured` are for (F-092-u): offering one
 * means the user picks it and the payment fails after they have chosen.
 */
@Injectable()
export class GatewayMerchant {
  constructor(private readonly vault: CredentialVaultService) {}

  async credentialsFor(gateway: MerchantGatewayRef, actorId: string | null = null): Promise<GatewayCredentials> {
    const merchantId = await this.vault.use(
      {
        tenantId: gateway.tenantId,
        kind: TenantCredentialKind.gateway_merchant_id,
        label: merchantLabel(gateway.source, gateway.gatewayId),
      },
      { caller: `billing:${gateway.providerName}`, actorId },
    );
    return { merchantId };
  }

  /**
   * The vault labels this tenant holds a merchant id under — one read, no
   * `tenant_credential_access` row, because nothing is decrypted. The list
   * filters on `merchantLabel(...)` of each gateway (F-092-u).
   */
  async configuredLabels(tenantId: string): Promise<Set<string>> {
    const credentials = await this.vault.list(tenantId);
    return new Set(
      credentials
        .filter((c) => c.kind === TenantCredentialKind.gateway_merchant_id && c.configured)
        .map((c) => c.label),
    );
  }

  /**
   * Refuses a gateway that has no usable merchant id, without decrypting one —
   * for the manual-fee path, which otherwise asks the vault nothing until the
   * payment itself (F-092-u).
   */
  async requireConfigured(gateway: MerchantGatewayRef): Promise<void> {
    const ref = {
      tenantId: gateway.tenantId,
      kind: TenantCredentialKind.gateway_merchant_id,
      label: merchantLabel(gateway.source, gateway.gatewayId),
    };
    const summary = await this.vault.summary(ref);
    if (!summary?.configured || summary.status !== TenantCredentialStatus.active) {
      throw new CredentialUnavailable(ref, summary ? 'revoked' : 'missing');
    }
  }
}
