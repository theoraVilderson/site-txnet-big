import { Prisma, TenantType, VariantBillingMode, type RateCardAfterIncluded, type RateCardMode } from '@prisma/client';
import { DOOR_METERS, METER_KEYS, packageMeterRatesAt } from '@txnet-backend/shared-core';

import { rateCardAt, vpnTrafficRateAt, type RateCardRow } from '../catalog/catalog-reads';

/** A `grant_meter` row as issue writes it, before its Grant and tenant are known. */
export type GrantMeterTerms = {
  meterKey: string;
  rateCardId: string;
  unitSize: bigint;
  unitPrice: Prisma.Decimal;
  currencyCode: string;
  mode: RateCardMode;
  includedQuantity: bigint;
  afterIncluded: RateCardAfterIncluded;
  consumed: bigint;
  billed: bigint;
  funded: bigint;
} & Partial<WholesaleTerms>;

/**
 * The wholesale leg locked beside a reseller's own card (F-118-n2): who pays
 * the platform, and the package rate in force at the sale, in the platform's
 * currency. `wholesaleBilled` is its own rating cursor over the same `consumed`.
 */
export type WholesaleTerms = {
  wholesalePayerTenantId: string;
  wholesaleRateId: string;
  wholesaleUnitSize: bigint;
  wholesaleUnitPrice: Prisma.Decimal;
  wholesaleCurrencyCode: string;
  wholesaleBilled: bigint;
};

type WholesaleReader = Pick<Prisma.TransactionClient, 'tenant' | 'tenantSubscription' | 'tenantPackageMeterRate'>;

/**
 * The meters a Grant is sold with (F-118-e, ADR-0105 decision 4): per meter,
 * the card in effect at `startsAt` in the tenant's currency (`rateCardAt`),
 * locked with its counters at zero — ADR-0073 for every meter.
 *
 * Only a meter something serves is locked, because a meter whose use nothing
 * refuses cannot be sold (decision 7):
 *  - `vpn.traffic` on a **metered** variant, when it is the card the byte
 *    engine serves (`vpnTrafficRateAt`): the Grant's rate and money cursor
 *    from then on (F-118-l). With none, issue refuses `metered_rate_missing` first.
 *  - `vpn.traffic` on any other variant is not read at all: a package plan's
 *    path never looks at a card (decision 0).
 *  - A `DOOR_METERS` meter (`vpn.config.regenerate`), on any variant: the
 *    per-use door refuses its unfunded use (F-118-h).
 *  - Any other meter in effect is `unserved`: issue refuses it as
 *    `meter_not_served`.
 */
export function grantMetersFromVariant(
  v: { billingMode: VariantBillingMode; rateCards: readonly RateCardRow[] },
  startsAt: Date,
  currencyCode: string,
): { meters: GrantMeterTerms[]; unserved: string | null } {
  const meters: GrantMeterTerms[] = [];
  const keys = [...new Set(v.rateCards.map((c) => c.meterKey))].sort();
  for (const meterKey of keys) {
    const card = rateCardAt(v.rateCards, startsAt, currencyCode, meterKey);
    if (!card) continue;
    if (meterKey !== METER_KEYS.vpnTraffic && !DOOR_METERS.has(meterKey)) return { meters: [], unserved: meterKey };
    if (meterKey === METER_KEYS.vpnTraffic && (v.billingMode !== VariantBillingMode.metered || !vpnTrafficRateAt(v.rateCards, startsAt, currencyCode))) continue;
    meters.push({
      meterKey,
      rateCardId: card.id,
      unitSize: card.unitSize,
      unitPrice: card.unitPrice,
      currencyCode: card.currencyCode,
      mode: card.mode,
      includedQuantity: card.includedQuantity,
      afterIncluded: card.afterIncluded,
      consumed: BigInt(0),
      billed: BigInt(0),
      funded: BigInt(0),
    });
  }
  return { meters, unserved: null };
}

/**
 * Locks the wholesale rate on each of a reseller's meters (F-118-n2, ADR-0105
 * decisions 4 and 10): the rate its package charges for that platform meter
 * at `startsAt`. Always, whatever panels the variant's group holds today — a
 * group's members change after the sale, and a Grant with no price must never
 * reach a platform panel (user, 2026-09-29); whether a unit is charged is its
 * panel owner's question, per usage (F-118-n3).
 *
 * The platform owner's own sale has no wholesale leg, and no meters (a package
 * plan, decision 0) reads nothing. `missing` names the first meter the package
 * does not price — or every one, for a reseller with no package: the sale is
 * then refused (`wholesale_rate_missing`).
 */
export async function lockWholesale(
  tx: WholesaleReader,
  tenantId: string,
  meters: GrantMeterTerms[],
  startsAt: Date,
): Promise<{ meters: GrantMeterTerms[]; missing: string | null }> {
  if (meters.length === 0) return { meters, missing: null };
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
  if (tenant?.tenantType !== TenantType.reseller) return { meters, missing: null };

  const subscription = await tx.tenantSubscription.findUnique({
    where: { tenantId },
    select: { package: { select: { id: true, currencyCode: true } } },
  });
  if (!subscription) return { meters: [], missing: meters[0].meterKey };
  const { id: packageId, currencyCode } = subscription.package;
  const rates = (await packageMeterRatesAt(tx, new Map([[packageId, currencyCode]]), startsAt)).get(packageId) ?? [];

  const locked: GrantMeterTerms[] = [];
  for (const meter of meters) {
    const rate = rates.find((r) => r.meterKey === meter.meterKey);
    if (!rate) return { meters: [], missing: meter.meterKey };
    locked.push({
      ...meter,
      wholesalePayerTenantId: tenantId,
      wholesaleRateId: rate.id,
      wholesaleUnitSize: rate.unitSize,
      wholesaleUnitPrice: rate.unitPrice,
      wholesaleCurrencyCode: rate.currencyCode,
      wholesaleBilled: BigInt(0),
    });
  }
  return { meters: locked, missing: null };
}
