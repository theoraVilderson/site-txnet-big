import { Injectable } from '@nestjs/common';
import { TenantCredentialKind, TenantGatewayConfig } from '@prisma/client';
import { CredentialVaultService } from '@txnet-backend/shared-core';

import type { GatewayCredentials } from './payment-provider';

/**
 * A reseller gateway's merchant id, from the tenant's vault (F-092-f, ADR-0006,
 * ADR-0026, ADR-0039) — never from `tenant_gateway_config.merchantIdEncrypted`,
 * which is deprecated and has never been written.
 *
 * The credential is `gateway_merchant_id`, labelled with the provider name:
 * `tenant_gateway_config` is unique on `(tenantId, providerName)`, so the label
 * names exactly one gateway and survives the config row being recreated.
 *
 * Every call is a `vault.use`, so every call writes a
 * `tenant_credential_access` row naming the driver and, when there is one, the
 * user the payment is for. The value is handed to one driver call and not kept.
 *
 * `CredentialUnavailable` passes through: a gateway with no merchant id in the
 * vault cannot take a payment, and the route decides what the user is told.
 */
@Injectable()
export class GatewayMerchant {
  constructor(private readonly vault: CredentialVaultService) {}

  async credentialsFor(
    gateway: Pick<TenantGatewayConfig, 'tenantId' | 'providerName'>,
    actorId: string | null = null,
  ): Promise<GatewayCredentials> {
    const merchantId = await this.vault.use(
      {
        tenantId: gateway.tenantId,
        kind: TenantCredentialKind.gateway_merchant_id,
        label: gateway.providerName,
      },
      { caller: `billing:${gateway.providerName}`, actorId },
    );
    return { merchantId };
  }
}
