import { Injectable } from '@nestjs/common';
import { PaymentProviderName, TenantCredentialKind, TenantCredentialStatus } from '@prisma/client';
import { CredentialUnavailable, CredentialVaultService } from '@txnet-backend/shared-core';

import { GrantedVaultAccess } from './granted-vault-access';
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
  /**
   * The grant this gateway is used under, or `null`/absent when the tenant owns
   * it (ADR-0041 §3, F-096-c). Naming one is what opens the owner's vault, and
   * it is proved before it opens anything — `GrantedVaultAccess`.
   */
  grantId?: string | null;
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
/**
 * **The one door** (ADR-0041 §3). Every vault read a gateway needs goes through
 * this class, so "a credential is read along a grant and nowhere else" is a
 * property of one file rather than a rule four call sites must remember: a ref
 * that names a grant is served through `GrantedVaultAccess`, one that does not
 * is served exactly as before.
 */
@Injectable()
export class GatewayMerchant {
  constructor(
    private readonly vault: CredentialVaultService,
    private readonly granted: GrantedVaultAccess,
  ) {}

  /**
   * Run `fn` where the credential actually lives: here for an owned gateway,
   * inside the proved grant for a borrowed one. `fn` is handed the tenant whose
   * vault answered, because for a grant that is re-derived rather than taken
   * from the ref.
   */
  private whereItLives<T>(gateway: MerchantGatewayRef, fn: (tenantId: string) => Promise<T>): Promise<T> {
    if (!gateway.grantId) return fn(gateway.tenantId);
    return this.granted.along(
      { grantId: gateway.grantId, source: gateway.source, gatewayId: gateway.gatewayId },
      fn,
    );
  }

  /** The audit tag the access row carries. A borrowed credential says which grant lent it. */
  private caller(gateway: MerchantGatewayRef): string {
    const base = `billing:${gateway.providerName}`;
    return gateway.grantId ? `${base}:grant:${gateway.grantId}` : base;
  }

  async credentialsFor(gateway: MerchantGatewayRef, actorId: string | null = null): Promise<GatewayCredentials> {
    const merchantId = await this.whereItLives(gateway, (tenantId) =>
      this.vault.use(
        {
          tenantId,
          kind: TenantCredentialKind.gateway_merchant_id,
          label: merchantLabel(gateway.source, gateway.gatewayId),
        },
        { caller: this.caller(gateway), actorId },
      ),
    );
    return { merchantId };
  }

  /**
   * The vault labels this tenant holds a merchant id under — one read, no
   * `tenant_credential_access` row, because nothing is decrypted. The list
   * filters on `merchantLabel(...)` of each gateway (F-092-u).
   */
  async configuredLabels(tenantId: string, grantId?: string | null, gateway?: { source: GatewaySource; gatewayId: string }): Promise<Set<string>> {
    const credentials = await (grantId && gateway
      ? this.granted.along({ grantId, ...gateway }, (owner) => this.vault.list(owner))
      : this.vault.list(tenantId));
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
    await this.whereItLives(gateway, async (tenantId) => {
      const ref = {
        tenantId,
        kind: TenantCredentialKind.gateway_merchant_id,
        label: merchantLabel(gateway.source, gateway.gatewayId),
      };
      const summary = await this.vault.summary(ref);
      if (!summary?.configured || summary.status !== TenantCredentialStatus.active) {
        throw new CredentialUnavailable(ref, summary ? 'revoked' : 'missing');
      }
    });
  }
}
