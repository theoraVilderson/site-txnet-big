import { Injectable } from '@nestjs/common';
import { FeeCalcMode, Prisma, TenantGatewayVerificationStatus, TenantType } from '@prisma/client';
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
 * A gateway comes from one of two tables, and every answer names which:
 *  - `tenant` — the request tenant's own `tenant_gateway_config`, selectable
 *    when active **and** verified. Read in a `tenantTransaction`: its RLS policy
 *    is strict and binds only on a connection that set `app.tenant_id`, so any
 *    other read would see nothing rather than fail.
 *  - `platform` — the platform brand's `payment_gateway`, selectable when
 *    active, and offered **only** when the request tenant is the
 *    `platform_owner` (ADR-0006, D-25). That table has no tenant column and no
 *    policy, so the tenant type read here is the whole of the boundary.
 * The platform owner is offered both. Its merchant id, for either, is its own
 * vault's `gateway_merchant_id` labelled with the provider; the plaintext
 * `payment_gateway.merchantId` column is never read.
 *
 * A quote reserves nothing and writes nothing. The provider's fee quote and the
 * vault read happen after the transaction closes: a database connection is
 * never held open across a call to a bank.
 */

/** Which table a gateway id belongs to. Ids never cross tables. */
export type GatewaySource = 'tenant' | 'platform';

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

const SELECTABLE = { isActive: true, verificationStatus: TenantGatewayVerificationStatus.verified };
const PLATFORM_SELECTABLE = { isActive: true };

/**
 * What a quote needs of a row — the columns both tables share. Selected
 * explicitly, so neither table's secret column is ever read: the deprecated
 * `*Encrypted` pair, or `payment_gateway.merchantId` (invariant 8).
 */
const GATEWAY_COLUMNS = {
  id: true,
  createdAt: true,
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
} satisfies Prisma.TenantGatewayConfigSelect & Prisma.PaymentGatewaySelect;

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
    const rows = await tenantTransaction(this.prisma, async (tx) => {
      const platform = (await this.isPlatformOwner(tx, tenant.id))
        ? await tx.paymentGateway.findMany({
            where: PLATFORM_SELECTABLE,
            select: GATEWAY_COLUMNS,
            orderBy: { createdAt: 'asc' },
          })
        : [];
      const own = await tx.tenantGatewayConfig.findMany({
        where: { ...SELECTABLE, tenantId: tenant.id },
        select: GATEWAY_COLUMNS,
        orderBy: { createdAt: 'asc' },
      });
      return [
        ...platform.map((g) => ({ ...g, source: 'platform' as const })),
        ...own.map((g) => ({ ...g, source: 'tenant' as const })),
      ];
    });
    return rows
      .filter((g) => this.providers.has(g.providerName))
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
      const gateway = await this.selectable(tx, tenant.id, gatewayId, request.source);
      if (!gateway) throw new DepositGatewayNotFound(gatewayId, request.source);
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
        // Either table's merchant id is the request tenant's vault entry for the
        // provider: a platform gateway is offered to the platform owner alone.
        const credentials = await this.merchant.credentialsFor(
          { tenantId: tenant.id, providerName: gateway.providerName },
          userId,
        );
        const { feeMinor } = await provider.quoteFee({ credentials, amountMinor });
        priceRequest.quotedFee = quotedFeeFromMinor(priceRequest, feeMinor);
      }
    }

    const price = priceAtGateway(priceRequest);
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

  private async isPlatformOwner(tx: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
    const row = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    return row?.tenantType === TenantType.platform_owner;
  }

  private async selectable(tx: Prisma.TransactionClient, tenantId: string, id: string, source: GatewaySource) {
    if (source === 'platform') {
      if (!(await this.isPlatformOwner(tx, tenantId))) return null;
      return tx.paymentGateway.findFirst({ where: { ...PLATFORM_SELECTABLE, id }, select: GATEWAY_COLUMNS });
    }
    return tx.tenantGatewayConfig.findFirst({ where: { ...SELECTABLE, id, tenantId }, select: GATEWAY_COLUMNS });
  }
}
