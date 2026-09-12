import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { CouponValidationService, RejectedCoupon } from '../coupon/coupon-validation';
import { GatewayMerchant, GatewaySource, merchantLabel } from '../gateway/gateway-merchant';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { FxRateReader } from '../pricing/fx-rate.reader';
import { priceDeposit, selectableGateways, selectGateway } from './deposit-pricing';

/**
 * What the panel's top-up page shows before anyone pays (F-092-o): the gateways
 * a user may pick, and the breakdown of one deposit at one of them.
 *
 * The panel renders this breakdown and does no arithmetic of its own — legacy
 * computed it twice, in `Deposit.tsx` and on the server, and the two drifted.
 * Every number here is `priceAtGateway`'s, through the `deposit-pricing.ts` the
 * payment intent charges with (F-092-i), so the quote and the charge cannot
 * disagree (F-0612).
 *
 * A gateway comes from one of two tables, and every answer names which:
 *  - `tenant` — the request tenant's own `tenant_gateway_config`, selectable
 *    when active **and** verified. Read in a `tenantTransaction`: its RLS policy
 *    is strict and binds only on a connection that set `app.tenant_id`, so any
 *    other read would see nothing rather than fail.
 *  - `platform` — the platform brand's `payment_gateway`, selectable when
 *    active, and offered **only** when the request tenant is the
 *    `platform_owner` (ADR-0006, D-25). That table has no tenant column and no
 *    policy, so the tenant type read there is the whole of the boundary.
 * The platform owner is offered both. Every gateway's merchant id is its own:
 * the request tenant's vault entry labelled with that gateway row (D-26,
 * `gateway-merchant.ts`); the plaintext `payment_gateway.merchantId` column is
 * never read.
 *
 * A gateway with no merchant id in the vault is not offered and cannot be
 * quoted (F-092-u): it would take the user to a payment that fails. A fully
 * discounted top-up is the exception, because it reaches no gateway at all.
 *
 * A quote reserves nothing and writes nothing. The provider's fee quote and the
 * vault read happen after the transaction closes: a database connection is
 * never held open across a call to a bank.
 */

/** Which table a gateway id belongs to. Ids never cross tables. */
export type { GatewaySource };

export type DepositGateway = {
  id: string;
  source: GatewaySource;
  displayName: string;
  providerName: string;
  category: string;
  /** Base currency, the gateway's accepted range for `amount`. */
  minAmount: string;
  maxAmount: string;
};

export type DepositQuoteRequest = {
  userId: string;
  gatewayId: string;
  source: GatewaySource;
  /** Base currency (ADR-0019), > 0, at most 2 decimal places. */
  amount: Prisma.Decimal;
  couponCodes: readonly string[];
};

/** Money as decimal strings in base currency; `amountMinor` as a string, since JSON has no bigint. */
export type DepositQuote = {
  gatewayId: string;
  source: GatewaySource;
  amount: string;
  /** The codes that discounted, in the order typed, each with what it took. */
  coupons: Array<{ code: string; discount: string }>;
  rejected: RejectedCoupon[];
  discount: string;
  gap: string;
  fee: string;
  payable: string;
  credited: string;
  free: boolean;
  /** What the gateway will be asked for. `null` on the free path. */
  charge: { currency: string; decimals: number; amountMinor: string } | null;
};

/** No active, verified gateway of this tenant has that id. */
export class DepositGatewayNotFound extends Error {
  constructor(
    readonly gatewayId: string,
    readonly source: GatewaySource,
  ) {
    super(`no selectable ${source} gateway ${gatewayId} for this tenant`);
    this.name = 'DepositGatewayNotFound';
  }
}

export const money = (v: Prisma.Decimal) => v.toFixed(2);

@Injectable()
export class DepositQuoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coupons: CouponValidationService,
    private readonly providers: PaymentProviderRegistry,
    private readonly merchant: GatewayMerchant,
    private readonly fx: FxRateReader,
  ) {}

  async listGateways(): Promise<DepositGateway[]> {
    const tenant = TenantContext.current('deposit gateways');
    const rows = await tenantTransaction(this.prisma, (tx) => selectableGateways(tx, tenant.id));
    // Outside the transaction: the vault queries on its own bound connection.
    const configured = await this.merchant.configuredLabels(tenant.id);
    return rows
      .filter((g) => this.providers.has(g.providerName))
      .filter((g) => configured.has(merchantLabel(g.source, g.id)))
      .map((g) => ({
        id: g.id,
        source: g.source,
        displayName: g.displayName,
        providerName: g.providerName,
        category: g.gatewayCategory,
        minAmount: money(g.minAcceptAmount),
        maxAmount: money(g.maxAcceptAmount),
      }));
  }

  async quote(request: DepositQuoteRequest): Promise<DepositQuote> {
    const tenant = TenantContext.current('deposit quote');
    const { userId, gatewayId, amount } = request;

    const { gateway, coupons } = await tenantTransaction(this.prisma, async (tx) => {
      const gateway = await selectGateway(tx, tenant.id, gatewayId, request.source);
      if (!gateway) throw new DepositGatewayNotFound(gatewayId, request.source);
      const coupons = await this.coupons.validate(tx, {
        codes: request.couponCodes,
        amount,
        target: { kind: 'wallet_top_up' },
        userId,
      });
      return { gateway, coupons };
    });

    const { provider, price } = await priceDeposit(
      { providers: this.providers, merchant: this.merchant, fx: this.fx },
      {
        gateway,
        ref: {
          tenantId: tenant.id,
          source: request.source,
          gatewayId: gateway.id,
          providerName: gateway.providerName,
        },
        amount,
        discount: coupons.totalDiscount,
        actorId: userId,
      },
    );

    return {
      gatewayId: gateway.id,
      source: request.source,
      amount: money(price.amount),
      coupons: coupons.applied.map((c) => ({ code: c.code, discount: money(c.discount) })),
      rejected: coupons.rejected,
      discount: money(price.discount),
      gap: money(price.gap),
      fee: money(price.fee),
      payable: money(price.payable),
      credited: money(price.credited),
      free: price.free,
      charge:
        price.chargedAmountMinor === null
          ? null
          : {
              currency: provider.chargeCurrency,
              decimals: provider.chargeDecimals,
              amountMinor: price.chargedAmountMinor.toString(),
            },
    };
  }
}
