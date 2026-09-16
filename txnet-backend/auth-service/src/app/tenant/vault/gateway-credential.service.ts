import { Injectable, Logger } from '@nestjs/common';
import { TenantCredentialKind, TenantType } from '@prisma/client';
import { CredentialVaultService, gatewayCredentialLabel, type GatewayCredentialSource } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';

/** One gateway row, named the way `billing` names it: which table, which id, whose vault. */
export type GatewayCredentialTarget = {
  tenantId: string;
  source: GatewayCredentialSource;
  gatewayId: string;
};

/**
 * The secrets a gateway carries. Any may be sent alone; absent means "leave it".
 * `webhookSecret` is what a webhook provider signs its posts with (F-104-c).
 */
export type GatewaySecrets = {
  merchantId?: string;
  secretKey?: string;
  webhookSecret?: string;
};

/** What a caller is told about one secret. Deliberately no value and no fingerprint. */
export type SecretState = {
  configured: boolean;
  version: number | null;
  rotatedAt: Date | null;
};

export type GatewayCredentialState = Record<keyof GatewaySecrets, SecretState>;

export type GatewayCredentialRejection = 'gateway_not_found' | 'not_owner' | 'empty_value' | 'nothing_to_set';

/** A refusal. Its message names the rule and the gateway, never a value. */
export class GatewayCredentialRefused extends Error {
  constructor(readonly reason: GatewayCredentialRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'GatewayCredentialRefused';
  }
}

const KINDS = {
  merchantId: TenantCredentialKind.gateway_merchant_id,
  secretKey: TenantCredentialKind.gateway_secret_key,
  webhookSecret: TenantCredentialKind.webhook_secret,
} as const satisfies Record<keyof GatewaySecrets, TenantCredentialKind>;

const NOT_CONFIGURED: SecretState = { configured: false, version: null, rotatedAt: null };

/**
 * The only writer of a payment gateway's secrets (F-102-a, D-31).
 *
 * `billing-service` owns the gateway rows but loads the vault read-only
 * (ADR-0039: its vault connection refuses `$transaction`, so it has no `put`).
 * Its management surface relays the merchant id, secret key and webhook
 * signing secret here over
 * `POST /internal/vault/gateway-credential` and keeps nothing.
 *
 * **The vault a secret lands in is re-derived, never trusted.** A caller names
 * a tenant and a gateway; this checks that the gateway row really is that
 * tenant's — a `tenant_gateway_config` by its `tenantId`, a `payment_gateway`
 * by the tenant being the platform owner — before anything is written. The
 * internal caller is a process holding `SERVICE_AUTH_TOKEN`, so this is defence
 * in depth behind `billing`'s own ownership rule, and it is the one that holds
 * if that rule is ever wrong: a merchant id written behind somebody else's
 * gateway is every payment through it paid into the wrong account.
 *
 * Reads on the cross-tenant pool for the same reason `VaultModule` binds the
 * vault to it: the tenant is the question, so the read cannot be scoped by it.
 */
@Injectable()
export class GatewayCredentialService {
  private readonly logger = new Logger(GatewayCredentialService.name);

  constructor(
    private readonly vault: CredentialVaultService,
    private readonly prisma: CrossTenantPrismaService,
  ) {}

  /** Store (or rotate) the secrets sent, and answer the state of both. */
  async set(target: GatewayCredentialTarget, secrets: GatewaySecrets, actorId: string | null): Promise<GatewayCredentialState> {
    const values = (Object.keys(KINDS) as Array<keyof GatewaySecrets>)
      .filter((k) => secrets[k] !== undefined && secrets[k] !== null)
      .map((k) => [k, String(secrets[k]).trim()] as const);
    if (values.length === 0) throw new GatewayCredentialRefused('nothing_to_set', target.gatewayId);
    const blank = values.find(([, v]) => v === '');
    if (blank) throw new GatewayCredentialRefused('empty_value', blank[0]);

    await this.assertOwner(target);

    const label = gatewayCredentialLabel(target.source, target.gatewayId);
    for (const [name, value] of values) {
      await this.vault.put({ tenantId: target.tenantId, kind: KINDS[name], label }, value, {
        createdBy: actorId ?? undefined,
      });
    }
    this.logger.log(`gateway ${target.source}:${target.gatewayId} secrets set (${values.map(([n]) => n).join(', ')})`);
    return this.read(target);
  }

  /** Whether each secret is configured. Decrypts nothing and writes no access row. */
  async state(target: GatewayCredentialTarget): Promise<GatewayCredentialState> {
    await this.assertOwner(target);
    return this.read(target);
  }

  /** Revoke every secret — the gateway is being deactivated or deleted (ADR-0041 §6). */
  async revoke(target: GatewayCredentialTarget): Promise<GatewayCredentialState> {
    await this.assertOwner(target);
    const label = gatewayCredentialLabel(target.source, target.gatewayId);
    for (const kind of Object.values(KINDS)) {
      await this.vault.revoke({ tenantId: target.tenantId, kind, label });
    }
    this.logger.log(`gateway ${target.source}:${target.gatewayId} secrets revoked`);
    return this.read(target);
  }

  private async read(target: GatewayCredentialTarget): Promise<GatewayCredentialState> {
    const label = gatewayCredentialLabel(target.source, target.gatewayId);
    const one = async (kind: TenantCredentialKind): Promise<SecretState> => {
      const s = await this.vault.summary({ tenantId: target.tenantId, kind, label });
      // Picked field by field, never spread: `CredentialSummary` carries the
      // fingerprint, and a spread is how it would reach a wire.
      return s?.configured ? { configured: true, version: s.version, rotatedAt: s.rotatedAt } : NOT_CONFIGURED;
    };
    return {
      merchantId: await one(KINDS.merchantId),
      secretKey: await one(KINDS.secretKey),
      webhookSecret: await one(KINDS.webhookSecret),
    };
  }

  private async assertOwner(target: GatewayCredentialTarget): Promise<void> {
    if (target.source === 'platform') {
      const gateway = await this.prisma.paymentGateway.findUnique({ where: { id: target.gatewayId }, select: { id: true } });
      if (!gateway) throw new GatewayCredentialRefused('gateway_not_found', target.gatewayId);
      const tenant = await this.prisma.tenant.findUnique({ where: { id: target.tenantId }, select: { tenantType: true } });
      if (tenant?.tenantType !== TenantType.platform_owner) {
        throw new GatewayCredentialRefused('not_owner', target.gatewayId);
      }
      return;
    }
    const config = await this.prisma.tenantGatewayConfig.findUnique({
      where: { id: target.gatewayId },
      select: { id: true, tenantId: true },
    });
    if (!config) throw new GatewayCredentialRefused('gateway_not_found', target.gatewayId);
    if (config.tenantId !== target.tenantId) throw new GatewayCredentialRefused('not_owner', target.gatewayId);
  }
}
