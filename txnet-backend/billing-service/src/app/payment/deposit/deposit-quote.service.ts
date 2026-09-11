import { Injectable } from '@nestjs/common';
import { FeeCalcMode, Prisma, TenantGatewayVerificationStatus } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { CouponValidationService, RejectedCoupon } from '../coupon/coupon-validation';
import { GatewayMerchant } from '../gateway/gateway-merchant';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import {
  feeQuoteAmountMinor,
  PriceRequest,
  priceAtGateway,
  quotedFeeFromMinor,
} from '../pricing/gateway-pricing';

/**
 * What the panel's top-up page shows before anyone pays (F-092-o): the gateways
 * a user may pick, and the breakdown of one deposit at one of them.
 *
 * The panel renders this breakdown and does no arithmetic of its own — legacy
 * computed it twice, in `Deposit.tsx` and on the server, and the two drifted.
 * Every number here is `priceAtGateway`'s, the function the payment intent
 * charges with (F-092-i), so the quote and the charge cannot disagree (F-0612).
 *
 * A gateway is a reseller's own `tenant_gateway_config` row (ADR-0006), and a
 * user may pick it only when it is active **and** verified. It is read in a
 * `tenantTransaction`: the table's RLS policy is strict and binds only on a
 * connection that set `app.tenant_id`, so any other read would see nothing
 * rather than fail. The platform brand's `payment_gateway` is not offered —
 * its merchant id is not in the vault yet (billing contract, "Payment
 * providers").
 *
 * A quote reserves nothing and writes nothing. The provider's fee quote and the
 * vault read happen after the transaction closes: a database connection is
 * never held open across a call to a bank.
 */

export type DepositGateway = {
  id: string;
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
  /** Base currency (ADR-0019), > 0, at most 2 decimal places. */
  amount: Prisma.Decimal;
  couponCodes: readonly string[];
};

/** Money as decimal strings in base currency; `amountMinor` as a string, since JSON has no bigint. */
export type DepositQuote = {
  gatewayId: string;
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
  constructor(readonly gatewayId: string) {
    super(`no selectable gateway ${gatewayId} for this tenant`);
    this.name = 'DepositGatewayNotFound';
  }
}

const SELECTABLE = { isActive: true, verificationStatus: TenantGatewayVerificationStatus.verified };

/** What a quote needs of the row. The deprecated `*Encrypted` columns are never selected (invariant 8). */
const GATEWAY_COLUMNS = {
  id: true,
  tenantId: true,
  displayName: true,
  providerName: true,
  gatewayCategory: true,
  minAcceptAmount: true,
  maxAcceptAmount: true,
  feeCalculationMode: true,
  feeType: true,
  feeValue: true,
  feeFloor: true,
  feeCeiling: true,
  useLiveRate: true,
  staticRate: true,
  percentageModifier: true,
  fixedAmountModifier: true,
  minRate: true,
  maxRate: true,
  roundingStep: true,
  roundingMode: true,
} satisfies Prisma.TenantGatewayConfigSelect;

const money = (v: Prisma.Decimal) => v.toFixed(2);

@Injectable()
export class DepositQuoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coupons: CouponValidationService,
    private readonly providers: PaymentProviderRegistry,
    private readonly merchant: GatewayMerchant,
  ) {}

  async listGateways(): Promise<DepositGateway[]> {
    const tenant = TenantContext.current('deposit gateways');
    const rows = await tenantTransaction(this.prisma, (tx) =>
      tx.tenantGatewayConfig.findMany({
        where: { ...SELECTABLE, tenantId: tenant.id },
        select: GATEWAY_COLUMNS,
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows
      .filter((g) => this.providers.has(g.providerName))
      .map((g) => ({
        id: g.id,
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
      const gateway = await tx.tenantGatewayConfig.findFirst({
        where: { ...SELECTABLE, id: gatewayId, tenantId: tenant.id },
        select: GATEWAY_COLUMNS,
      });
      if (!gateway) throw new DepositGatewayNotFound(gatewayId);
      const coupons = await this.coupons.validate(tx, {
        codes: request.couponCodes,
        amount,
        target: { kind: 'wallet_top_up' },
        userId,
      });
      return { gateway, coupons };
    });

    const provider = this.providers.get(gateway.providerName);
    const priceRequest: PriceRequest = {
      pricing: gateway,
      amount,
      discount: coupons.totalDiscount,
      // No FX worker yet: the gateway prices from its `staticRate` or refuses.
      // F-092-c passes the rate the staleness ladder allows.
      liveRate: null,
      chargeDecimals: provider.chargeDecimals,
    };

    if (gateway.feeCalculationMode === FeeCalcMode.automatic) {
      const amountMinor = feeQuoteAmountMinor(priceRequest);
      if (amountMinor !== null) {
        const credentials = await this.merchant.credentialsFor(gateway, userId);
        const { feeMinor } = await provider.quoteFee({ credentials, amountMinor });
        priceRequest.quotedFee = quotedFeeFromMinor(priceRequest, feeMinor);
      }
    }

    const price = priceAtGateway(priceRequest);
    return {
      gatewayId: gateway.id,
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
