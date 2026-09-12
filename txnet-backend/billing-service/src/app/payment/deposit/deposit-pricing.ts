import { FeeCalcMode, Prisma, TenantGatewayVerificationStatus, TenantType } from '@prisma/client';

import type { GatewayMerchant, GatewaySource, MerchantGatewayRef } from '../gateway/gateway-merchant';
import type { PaymentProvider } from '../gateway/payment-provider';
import type { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import type { FxRateReader } from '../pricing/fx-rate.reader';
import {
  feeBasis,
  feeQuoteAmountMinor,
  GatewayPrice,
  PriceRequest,
  priceAtGateway,
  quotedFeeFromMinor,
} from '../pricing/gateway-pricing';

/**
 * The half of a deposit that the quote (F-092-o) and the payment (F-092-i)
 * must agree on: which gateway rows a tenant may select, and what one of them
 * charges for an amount.
 *
 * It lives here rather than in either service because "the quote shown and the
 * amount charged both come from `priceAtGateway`" is a contract rule, and the
 * cheapest way to hold a rule like that is to leave one copy of the call. F-0612
 * is the legacy version of getting it wrong: the breakdown was computed in the
 * browser and again on the server, and the two drifted.
 *
 * Nothing here writes, and nothing here is inside a transaction of its own: the
 * row read takes the caller's `tx`, and the vault and provider calls happen
 * after it has closed — a database connection is never held across a call to a
 * bank.
 */

const SELECTABLE = { isActive: true, verificationStatus: TenantGatewayVerificationStatus.verified };
const PLATFORM_SELECTABLE = { isActive: true };

/**
 * What a quote needs of a row — the columns both tables share. Selected
 * explicitly, so neither table's secret column is ever read: the deprecated
 * `*Encrypted` pair, or `payment_gateway.merchantId` (invariant 8).
 */
export const GATEWAY_COLUMNS = {
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

export type SelectedGateway = Prisma.TenantGatewayConfigGetPayload<{ select: typeof GATEWAY_COLUMNS }>;

/**
 * `payment_gateway` has no tenant column and no RLS policy, so this read is the
 * whole of the boundary that keeps a reseller off the platform brand's gateways
 * (ADR-0006, D-25).
 */
export async function isPlatformOwner(tx: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
  const row = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
  return row?.tenantType === TenantType.platform_owner;
}

/** The gateway row this tenant may select under that id, or `null`. */
export async function selectGateway(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
  source: GatewaySource,
): Promise<SelectedGateway | null> {
  if (source === 'platform') {
    if (!(await isPlatformOwner(tx, tenantId))) return null;
    return tx.paymentGateway.findFirst({ where: { ...PLATFORM_SELECTABLE, id }, select: GATEWAY_COLUMNS });
  }
  return tx.tenantGatewayConfig.findFirst({ where: { ...SELECTABLE, id, tenantId }, select: GATEWAY_COLUMNS });
}

/** Every active gateway row this tenant may select, platform ones first, each table oldest first. */
export async function selectableGateways(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<Array<SelectedGateway & { source: GatewaySource }>> {
  const platform = (await isPlatformOwner(tx, tenantId))
    ? await tx.paymentGateway.findMany({
        where: PLATFORM_SELECTABLE,
        select: GATEWAY_COLUMNS,
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const own = await tx.tenantGatewayConfig.findMany({
    where: { ...SELECTABLE, tenantId },
    select: GATEWAY_COLUMNS,
    orderBy: { createdAt: 'asc' },
  });
  return [
    ...platform.map((g) => ({ ...g, source: 'platform' as const })),
    ...own.map((g) => ({ ...g, source: 'tenant' as const })),
  ];
}

export type DepositPricingInput = {
  gateway: SelectedGateway;
  ref: MerchantGatewayRef;
  /** Base currency (ADR-0019). */
  amount: Prisma.Decimal;
  /** Every applied coupon together, as validation answered it. */
  discount: Prisma.Decimal;
  /** The user the vault access is attributed to. */
  actorId: string;
};

export type DepositPricing = { provider: PaymentProvider; price: GatewayPrice };

/**
 * What this gateway charges for this amount — the breakdown a quote renders and
 * a payment is written with.
 *
 * The provider's fee quote and the vault read happen here, outside any
 * transaction. A `useLiveRate` gateway is priced at the rate the FX worker last
 * published (F-092-c); one that does not ask for a live rate is never read for.
 * A gateway with no usable merchant id is refused even on the manual-fee path,
 * which decrypts nothing of its own (F-092-u) — the free path asks neither,
 * because nothing reaches the gateway.
 */
export async function priceDeposit(
  deps: {
    providers: PaymentProviderRegistry;
    merchant: GatewayMerchant;
    fx: FxRateReader;
  },
  input: DepositPricingInput,
): Promise<DepositPricing> {
  const { gateway, ref, amount, discount, actorId } = input;
  const provider = deps.providers.get(gateway.providerName);
  const request: PriceRequest = {
    pricing: gateway,
    amount,
    discount,
    liveRate: gateway.useLiveRate ? await deps.fx.current() : null,
    chargeDecimals: provider.chargeDecimals,
  };

  if (gateway.feeCalculationMode === FeeCalcMode.automatic) {
    const amountMinor = feeQuoteAmountMinor(request);
    if (amountMinor !== null) {
      const credentials = await deps.merchant.credentialsFor(ref, actorId);
      const { feeMinor } = await provider.quoteFee({ credentials, amountMinor });
      request.quotedFee = quotedFeeFromMinor(request, feeMinor);
    }
  } else if (!feeBasis(request).isZero()) {
    await deps.merchant.requireConfigured(ref);
  }

  return { provider, price: priceAtGateway(request) };
}
