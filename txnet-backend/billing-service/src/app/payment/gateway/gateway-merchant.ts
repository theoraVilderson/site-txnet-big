import { Injectable } from '@nestjs/common';
import { PaymentProviderName, TenantCredentialStatus } from '@prisma/client';
import {
  CredentialUnavailable,
  CredentialVaultService,
  gatewayCredentialLabel,
  type GatewayCredentialSource,
} from '@txnet-backend/shared-core';

import { GrantedVaultAccess } from './granted-vault-access';
import type { GatewayCredentials } from './payment-provider';
import { GATEWAY_SECRET_NAMES, type GatewaySecretName, PROVIDER_FIELDS, SECRET_KIND } from './provider-fields';

/** Which table a gateway row is in: a tenant's `tenant_gateway_config`, or the platform brand's `payment_gateway`. */
export type GatewaySource = GatewayCredentialSource;

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
 * in the shape the bot's `bot:<platform>:<username>` labels already use. The
 * spelling is `shared-core`'s, because `auth-service` writes under it (F-102-a).
 */
export const merchantLabel = (source: GatewaySource, gatewayId: string) => gatewayCredentialLabel(source, gatewayId);

/** The secrets a payment call needs: the provider's own, minus the webhook secret. */
const paymentSecretsOf = (provider: PaymentProviderName) =>
  (PROVIDER_FIELDS[provider]?.secrets ?? []).filter((n): n is Exclude<GatewaySecretName, 'webhookSecret'> => n !== 'webhookSecret');

/**
 * Whether a gateway holds every secret its provider declares — what keeps it on
 * the top-up page (F-092-u). A Stripe gateway has no merchant id, so the old
 * "has a merchant id" test would have hidden it for ever (F-104-g).
 */
export function hasEverySecret(
  configured: ReadonlyMap<string, ReadonlySet<GatewaySecretName>> | undefined,
  gateway: { source: GatewaySource; gatewayId: string; providerName: PaymentProviderName },
): boolean {
  const held = configured?.get(merchantLabel(gateway.source, gateway.gatewayId));
  return (PROVIDER_FIELDS[gateway.providerName]?.secrets ?? []).every((n) => held?.has(n) ?? false);
}

/**
 * A gateway's secrets, from its tenant's vault (F-092-f, ADR-0006,
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
 * `configuredSecrets` and `requireConfigured` are for (F-092-u): offering one
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

  /**
   * The secrets this gateway's provider declares (`provider-fields.ts`) —
   * Zarinpal's merchant id, Stripe's secret key (F-104-g) — each a `use`, so
   * each writes its own access row. The webhook secret is never among them:
   * only `webhookSecretFor` reads it, for `verifyWebhook`.
   */
  async credentialsFor(gateway: MerchantGatewayRef, actorId: string | null = null): Promise<GatewayCredentials> {
    const credentials: GatewayCredentials = {};
    for (const name of paymentSecretsOf(gateway.providerName)) {
      credentials[name] = await this.whereItLives(gateway, (tenantId) =>
        this.vault.use(
          { tenantId, kind: SECRET_KIND[name], label: merchantLabel(gateway.source, gateway.gatewayId) },
          { caller: this.caller(gateway), actorId },
        ),
      );
    }
    return credentials;
  }

  /**
   * A webhook provider's signing secret for this gateway (F-104-c): kind
   * `webhook_secret` under the same row label as the merchant id, written by
   * `tenant-service` beside it — or whichever stored secret the provider signs
   * with (`webhookSignedWith`: OxaPay's merchant key, F-104-i). A `use`, so
   * audited like the merchant id.
   * `CredentialUnavailable` passes through; `WebhookSecretSource` decides what
   * a missing one means.
   */
  async webhookSecretFor(gateway: MerchantGatewayRef): Promise<string> {
    return this.whereItLives(gateway, (tenantId) =>
      this.vault.use(
        {
          tenantId,
          kind: SECRET_KIND[PROVIDER_FIELDS[gateway.providerName]?.webhookSignedWith ?? 'webhookSecret'],
          label: merchantLabel(gateway.source, gateway.gatewayId),
        },
        { caller: this.caller(gateway), actorId: null },
      ),
    );
  }

  /**
   * Which secrets this tenant holds, per gateway label — one read, no
   * `tenant_credential_access` row, because nothing is decrypted. The list
   * keeps a gateway only when {@link hasEverySecret} (F-092-u, F-104-g).
   */
  async configuredSecrets(
    tenantId: string,
    grantId?: string | null,
    gateway?: { source: GatewaySource; gatewayId: string },
  ): Promise<Map<string, Set<GatewaySecretName>>> {
    const credentials = await (grantId && gateway
      ? this.granted.along({ grantId, ...gateway }, (owner) => this.vault.list(owner))
      : this.vault.list(tenantId));
    const nameOf = new Map(GATEWAY_SECRET_NAMES.map((n) => [SECRET_KIND[n], n] as const));
    const out = new Map<string, Set<GatewaySecretName>>();
    for (const c of credentials) {
      const name = nameOf.get(c.kind);
      if (!name || !c.configured) continue;
      if (!out.has(c.label)) out.set(c.label, new Set());
      out.get(c.label)!.add(name);
    }
    return out;
  }

  /**
   * Refuses a gateway missing any secret its provider declares, without
   * decrypting one — for the manual-fee path, which otherwise asks the vault
   * nothing until the payment itself (F-092-u, F-104-g).
   */
  async requireConfigured(gateway: MerchantGatewayRef): Promise<void> {
    await this.whereItLives(gateway, async (tenantId) => {
      for (const name of PROVIDER_FIELDS[gateway.providerName]?.secrets ?? []) {
        const ref = { tenantId, kind: SECRET_KIND[name], label: merchantLabel(gateway.source, gateway.gatewayId) };
        const summary = await this.vault.summary(ref);
        if (!summary?.configured || summary.status !== TenantCredentialStatus.active) {
          throw new CredentialUnavailable(ref, summary ? 'revoked' : 'missing');
        }
      }
    });
  }
}
