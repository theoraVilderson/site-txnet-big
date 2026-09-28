import { Injectable } from '@nestjs/common';
import { CouponChannel, Prisma, TenantType } from '@prisma/client';
import { holdsPermission, runWithTenant } from '@txnet-backend/shared-core';

import { platformOwnerTenantId } from '../payment/deposit/deposit-pricing';
import { DepositGateway, DepositQuoteService } from '../payment/deposit/deposit-quote.service';
import { DepositStarted, DepositStartService } from '../payment/deposit/deposit-start.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A reseller tops up its billing wallet with the platform (F-019-b, D-41,
 * ADR-0056), through the platform owner's gateways.
 *
 * **The payment is the platform owner's.** The platform is the merchant, so
 * the `payment_transaction` row, the gateway, the vault read, the callback
 * host and the webhook scope are all the owner's, exactly as for one of its
 * own users' top-ups: this opens the owner's scope and hands the existing
 * `DepositStartService` the one thing that differs, `billingTenantId`.
 * Settlement credits that tenant's `tenant_billing_wallet` instead of a user
 * wallet (`DepositSettlementService.creditVerified`). No coupon — a coupon is
 * a user's — and no test mode.
 *
 * **Who.** Inside a reseller only (the platform owner has no billing wallet):
 * its owner, or a staff member holding `tenant_billing.topup`. The permission
 * header is the reseller's own roles, so an `Admin` of another tenant holds
 * nothing here.
 */

export const TENANT_BILLING_TOPUP = 'tenant_billing.topup';

export type TopupActor = { userId: string; tenantId: string; permissions: readonly string[] };

export type TopupInput = {
  gatewayId: string;
  /** The platform's currency (C-02, ADR-0098 part 4), a decimal string > 0 with at most 2 places — the schema's. */
  amount: string;
};

/** Why a top-up was refused before any gateway was read. Closed — the controller gives each a status. */
export type TenantTopupRejection = 'not_a_reseller' | 'not_permitted' | 'platform_unavailable';

export class TenantTopupRefused extends Error {
  constructor(readonly reason: TenantTopupRejection) {
    super(`billing top-up refused: ${reason}`);
    this.name = 'TenantTopupRefused';
  }
}

/**
 * Who may act on a reseller's billing wallet from inside it — top it up
 * (F-019-b) or read it (F-019-d): its owner, or a staff member holding
 * `tenant_billing.topup`, and only inside a reseller. `tenant.tenant` has no
 * RLS policy, so the reseller's own connection can answer this.
 */
export async function admitResellerBilling(prisma: PrismaService, actor: TopupActor): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: actor.tenantId },
    select: { tenantType: true, ownerUserId: true },
  });
  if (tenant?.tenantType !== TenantType.reseller) throw new TenantTopupRefused('not_a_reseller');
  if (tenant.ownerUserId !== actor.userId && !holdsPermission(actor.permissions, TENANT_BILLING_TOPUP)) {
    throw new TenantTopupRefused('not_permitted');
  }
}

@Injectable()
export class TenantTopupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deposits: DepositQuoteService,
    private readonly starts: DepositStartService,
  ) {}

  /** The platform owner's platform gateways, as its own top-up page lists them. */
  async gateways(actor: TopupActor): Promise<DepositGateway[]> {
    const owner = await this.access(actor);
    const rows = await runWithTenant({ id: owner }, () =>
      this.deposits.listGateways({ canTest: false, chatPlatform: null }),
    );
    // The owner is also offered its own `tenant_gateway_config` rows; a billing
    // top-up is on a `payment_gateway` only (the row's CHECK).
    return rows.filter((g) => g.source === 'platform');
  }

  async start(actor: TopupActor, input: TopupInput, origin: string | null): Promise<DepositStarted> {
    const owner = await this.access(actor);
    return runWithTenant({ id: owner }, () =>
      this.starts.start({
        userId: actor.userId,
        gatewayId: input.gatewayId,
        source: 'platform',
        amount: new Prisma.Decimal(input.amount),
        couponCodes: [],
        channel: CouponChannel.panel,
        // Kept only if the owner vouches for it (`FRONTEND_ORIGIN`, its own
        // panel hosts); otherwise the result redirect is relative, on the
        // platform's host the bank returned to.
        origin,
        canTest: false,
        chat: null,
        billingTenantId: actor.tenantId,
      }),
    );
  }

  /** The one door. Answers the platform owner's tenant id, whose scope the payment is made in. */
  private async access(actor: TopupActor): Promise<string> {
    await admitResellerBilling(this.prisma, actor);
    const owner = await platformOwnerTenantId(this.prisma as unknown as Prisma.TransactionClient);
    if (!owner) throw new TenantTopupRefused('platform_unavailable');
    return owner;
  }
}
