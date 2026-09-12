import { FeeCalcMode, Prisma, TenantGatewayVerificationStatus, TenantType } from '@prisma/client';

import type { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
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
 * A gateway row as it is offered to one tenant, with the two facts a grant adds
 * (ADR-0041, F-096-b).
 *
 * `grantId` is `null` for the ordinary case — the tenant owns the row, or is the
 * platform owner reading the platform's own. Non-null means the row belongs to
 * somebody else and this tenant may use it because the platform owner said so.
 *
 * `ownerTenantId` is **whose vault holds its merchant id**, which is the whole
 * reason the field exists: a granted gateway is charged with its owner's
 * account (D-26, ADR-0041 §3), so the caller's tenant is the wrong place to
 * look and would answer "no merchant id" — which F-092-u turns into a gateway
 * silently missing from the list.
 */
export type GatewayOffer = SelectedGateway & {
  source: GatewaySource;
  grantId: string | null;
  ownerTenantId: string;
};

/**
 * `payment_gateway` has no tenant column and no RLS policy, so this read is the
 * whole of the boundary that keeps a reseller off the platform brand's gateways
 * (ADR-0006, D-25).
 */
export async function isPlatformOwner(tx: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
  const row = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
  return row?.tenantType === TenantType.platform_owner;
}

/**
 * The platform owner's tenant — whose vault holds every `payment_gateway` row's
 * merchant id (D-25). Read rather than configured: `tenant.tenant` carries no
 * `tenantId` column and so no RLS policy, which is what lets any tenant's
 * connection answer this at all.
 */
async function platformOwnerTenantId(tx: Prisma.TransactionClient): Promise<string | null> {
  const row = await tx.tenant.findFirst({
    where: { tenantType: TenantType.platform_owner },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * The live grants this tenant holds (ADR-0041 §1). Scoped by RLS to the
 * **borrowing** tenant, which is what `payment_gateway_grant.tenantId` means —
 * so a caller can only ever learn about grants made to it.
 */
function liveGrants(tx: Prisma.TransactionClient, tenantId: string) {
  return tx.paymentGatewayGrant.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, gatewayId: true, tenantGatewayConfigId: true },
    orderBy: { grantedAt: 'asc' },
  });
}

/**
 * The gateway rows this tenant may use because somebody granted them
 * (ADR-0041 §1, §6).
 *
 * **Why this holds `CrossTenantPrismaService`, and why that is narrower than it
 * looks.** A granted `tenant_gateway_config` row belongs to the *lender*, and
 * that table's RLS policy is strict — on the borrower's connection it answers
 * nothing, which would leave a granted gateway invisible rather than refused.
 * The read cannot be scoped by the borrower, so it is scoped by **the grant**
 * instead: the ids come from `liveGrants`, which the borrower's own scope
 * proved, and nothing outside that list is ever asked for. It selects
 * `GATEWAY_COLUMNS`, so neither table's secret column is read (invariant 8).
 *
 * The alternative was a wider RLS policy on `tenant_gateway_config` — visible
 * to every query from every service for ever, including the deprecated
 * `*Encrypted` columns — against one bounded read in one function. ADR-0040
 * made the same call for a shared coupon's counters.
 *
 * **A dead gateway disappears everywhere at once** (§6): `isActive` and
 * `verified` are checked on the row here exactly as they are for an own
 * gateway, so a lender deactivating its gateway withdraws it from every tenant
 * it was granted to without anyone touching a grant.
 */
async function grantedGateways(
  tx: Prisma.TransactionClient,
  crossTenant: CrossTenantPrismaService,
  tenantId: string,
): Promise<GatewayOffer[]> {
  const grants = await liveGrants(tx, tenantId);
  if (grants.length === 0) return [];

  const platformIds = grants.filter((g) => g.gatewayId).map((g) => g.gatewayId as string);
  const configIds = grants.filter((g) => g.tenantGatewayConfigId).map((g) => g.tenantGatewayConfigId as string);
  const grantOf = new Map<string, string>(
    grants.map((g) => [(g.gatewayId ?? g.tenantGatewayConfigId) as string, g.id]),
  );

  const offers: GatewayOffer[] = [];

  if (platformIds.length > 0) {
    const platformOwner = await platformOwnerTenantId(tx);
    // No platform owner tenant means no vault to charge against; a grant of a
    // platform gateway is unusable rather than free.
    if (platformOwner) {
      const rows = await tx.paymentGateway.findMany({
        where: { ...PLATFORM_SELECTABLE, id: { in: platformIds } },
        select: GATEWAY_COLUMNS,
        orderBy: { createdAt: 'asc' },
      });
      offers.push(
        ...rows.map((g) => ({
          ...g,
          source: 'platform' as const,
          grantId: grantOf.get(g.id) ?? null,
          ownerTenantId: platformOwner,
        })),
      );
    }
  }

  if (configIds.length > 0) {
    const rows = await crossTenant.tenantGatewayConfig.findMany({
      where: { ...SELECTABLE, id: { in: configIds } },
      select: { ...GATEWAY_COLUMNS, tenantId: true },
      orderBy: { createdAt: 'asc' },
    });
    offers.push(
      ...rows.map(({ tenantId: ownerTenantId, ...g }) => ({
        ...g,
        source: 'tenant' as const,
        grantId: grantOf.get(g.id) ?? null,
        ownerTenantId,
      })),
    );
  }

  return offers;
}

/** The gateway row this tenant may select under that id, or `null`. */
export async function selectGateway(
  tx: Prisma.TransactionClient,
  crossTenant: CrossTenantPrismaService,
  tenantId: string,
  id: string,
  source: GatewaySource,
): Promise<GatewayOffer | null> {
  if (source === 'platform') {
    if (await isPlatformOwner(tx, tenantId)) {
      const row = await tx.paymentGateway.findFirst({
        where: { ...PLATFORM_SELECTABLE, id },
        select: GATEWAY_COLUMNS,
      });
      return row ? { ...row, source, grantId: null, ownerTenantId: tenantId } : null;
    }
  } else {
    const row = await tx.tenantGatewayConfig.findFirst({
      where: { ...SELECTABLE, id, tenantId },
      select: GATEWAY_COLUMNS,
    });
    if (row) return { ...row, source, grantId: null, ownerTenantId: tenantId };
  }
  // Not this tenant's own. It may still be granted to it — and a grant is
  // checked second on purpose: owning a row is cheaper to prove and is the
  // ordinary case, so the grant read costs nothing on every other payment.
  const granted = await grantedGateways(tx, crossTenant, tenantId);
  return granted.find((g) => g.id === id && g.source === source) ?? null;
}

/**
 * Every active gateway row this tenant may select: the platform's own (it being
 * the platform owner), then its own, then the ones granted to it — each group
 * oldest first.
 *
 * Granted rows come last because they are somebody else's: a tenant's own
 * gateway is the one it configured and the one it would expect to see first.
 */
export async function selectableGateways(
  tx: Prisma.TransactionClient,
  crossTenant: CrossTenantPrismaService,
  tenantId: string,
): Promise<GatewayOffer[]> {
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
  const granted = await grantedGateways(tx, crossTenant, tenantId);
  return [
    ...platform.map((g) => ({ ...g, source: 'platform' as const, grantId: null, ownerTenantId: tenantId })),
    ...own.map((g) => ({ ...g, source: 'tenant' as const, grantId: null, ownerTenantId: tenantId })),
    // A row already offered as this tenant's own is not offered twice: a
    // platform owner granted its own gateway would otherwise see it doubled.
    ...granted.filter((g) => !platform.some((p) => p.id === g.id) && !own.some((o) => o.id === g.id)),
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
