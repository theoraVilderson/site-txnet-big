import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';
import { TenantType } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { GatewaySource } from './gateway-merchant';

/**
 * The one crossing of ADR-0039's tenant-bound vault connection, and the key
 * that opens it (ADR-0041 §3, F-096-c).
 *
 * `tenant-bound-vault-db.ts` binds every vault query to **the tenant of the
 * request**, so a credential belonging to anyone else is not merely filtered
 * out — Row-Level Security shows no row at all. That is the property this
 * service was built to have, and a granted gateway is the one case that has to
 * cross it: the gateway is charged with its **owner's** merchant id (D-26), so
 * a payment inside the borrowing tenant must read a credential of the lending
 * one.
 *
 * **A narrow path, not a second pool.** The obvious fix — give the vault the
 * cross-tenant connection — would let every vault read in this service reach
 * every tenant's credentials, for ever, to serve one case. Instead the bind
 * target is overridden for the duration of exactly one call, and only after a
 * grant has been **proved** rather than passed in:
 *
 * 1. the grant is read on the **application** pool, inside the caller's own
 *    tenant scope, so RLS itself is what says the grant was made to this
 *    tenant — a forged grant id belonging to somebody else answers nothing;
 * 2. it must be live, and must name the gateway being charged;
 * 3. the owner is **re-derived here**, never taken from the caller: for a
 *    platform gateway it is the platform owner tenant, and for a reseller's it
 *    is that row's own `tenantId`, read on the cross-tenant pool for that one
 *    id.
 *
 * Only then is the override opened, and it closes when the call returns. There
 * is no way to open it without a grant, which is the whole of §3: *the grant is
 * the only key*.
 *
 * **Audited by construction.** The vault writes a `tenant_credential_access`
 * row for every `use`, and inside the override that row lands in the **owner's**
 * scope — so a lender can see every use of its credential — carrying a caller
 * tag that names the grant (`GatewayMerchant`). Nothing here has to remember to
 * log.
 */

type VaultTenantOverride = {
  /** Whose vault the enclosed call reads. */
  tenantId: string;
  /** The proved grant that opened it, for the audit tag. */
  grantId: string;
};

const override = new AsyncLocalStorage<VaultTenantOverride>();

/** The tenant the enclosing grant opened, or `null`. Read by `tenantBoundVaultDb`. */
export function vaultTenantOverride(): VaultTenantOverride | null {
  return override.getStore() ?? null;
}

/** A grant that cannot be used: withdrawn, never made, or not this gateway's. */
export class GrantNotUsable extends Error {
  constructor(
    readonly grantId: string,
    readonly reason: 'not_found' | 'wrong_gateway' | 'no_owner',
  ) {
    super(`grant ${grantId} cannot be used: ${reason}`);
    this.name = 'GrantNotUsable';
  }
}

/** What is being charged, as the caller knows it. The owner is not among the inputs on purpose. */
export type GrantedGateway = {
  grantId: string;
  source: GatewaySource;
  gatewayId: string;
};

@Injectable()
export class GrantedVaultAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  /**
   * Run `fn` with the vault bound to the gateway owner's tenant, having proved
   * the grant first. Throws `GrantNotUsable` if it cannot be proved, and never
   * opens the override in that case.
   */
  async along<T>(gateway: GrantedGateway, fn: (ownerTenantId: string) => Promise<T>): Promise<T> {
    const borrower = TenantContext.current('granted vault access').id;
    const ownerTenantId = await this.ownerAlong(gateway, borrower);
    return override.run({ tenantId: ownerTenantId, grantId: gateway.grantId }, () => fn(ownerTenantId));
  }

  /**
   * The tenant whose vault a grant opens — proved, not accepted.
   *
   * The grant read runs on the application pool inside the borrower's scope, so
   * the policy on `payment_gateway_grant` is what refuses a grant made to
   * somebody else. Everything after it is about the gateway row, which the
   * borrower cannot see and the grant now entitles us to ask about.
   */
  private async ownerAlong(gateway: GrantedGateway, borrower: string): Promise<string> {
    const { grantId, gatewayId, source } = gateway;

    const grant = await tenantTransaction(this.prisma, (tx) =>
      tx.paymentGatewayGrant.findFirst({
        where: { id: grantId, tenantId: borrower, isActive: true },
        select: { gatewayId: true, tenantGatewayConfigId: true },
      }),
    );
    if (!grant) throw new GrantNotUsable(grantId, 'not_found');

    const granted = source === 'platform' ? grant.gatewayId : grant.tenantGatewayConfigId;
    // A live grant of a *different* gateway is not a key to this one. Without
    // this the borrower would need only one grant to reach any gateway.
    if (granted !== gatewayId) throw new GrantNotUsable(grantId, 'wrong_gateway');

    if (source === 'platform') {
      const owner = await tenantTransaction(this.prisma, (tx) =>
        tx.tenant.findFirst({ where: { tenantType: TenantType.platform_owner }, select: { id: true } }),
      );
      if (!owner) throw new GrantNotUsable(grantId, 'no_owner');
      return owner.id;
    }

    // The lender's row, by the id the proved grant named and by nothing else.
    const config = await this.crossTenant.tenantGatewayConfig.findUnique({
      where: { id: gatewayId },
      select: { tenantId: true },
    });
    if (!config) throw new GrantNotUsable(grantId, 'no_owner');
    return config.tenantId;
  }
}
