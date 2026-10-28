import { Prisma, TenantType, VariantBillingMode, type RateCardAfterIncluded, type RateCardMode } from '@prisma/client';
import { DOOR_METERS, METER_KEYS, packageMeterRatesAt } from '@txnet-backend/shared-core';

import { rateCardAt, vpnTrafficRateAt, type RateCardRow } from '../catalog/catalog-reads';
import { onPlatformPanel } from '../traffic/vpn-wholesale';

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

type WholesaleReader = Pick<Prisma.TransactionClient, 'tenant' | 'tenantSubscription' | 'tenantPackageMeterRate' | 'panelGroupMember'>;

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
 * at `startsAt`, whenever the package has one — so a platform panel that joins
 * the group later is still charged; whether a unit is, is its panel owner's
 * question, per usage (F-118-n3).
 *
 * A meter the package does not price — or every one, for a reseller with no
 * package — is refused (`missing`, `wholesale_rate_missing`) only when the
 * variant's group holds a platform panel at the sale; on the reseller's own
 * panels it sells with no leg (F-118-n7, user 2026-10-26, as a package plan
 * does — package rule 4). The platform owner's own sale has no wholesale leg,
 * and no meters (a package plan, decision 0) reads nothing.
 */
export async function lockWholesale(
  tx: WholesaleReader,
  sale: { tenantId: string; panelGroupId: string | null },
  meters: GrantMeterTerms[],
  startsAt: Date,
): Promise<{ meters: GrantMeterTerms[]; missing: string | null }> {
  if (meters.length === 0) return { meters, missing: null };
  const { tenantId } = sale;
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
  if (tenant?.tenantType !== TenantType.reseller) return { meters, missing: null };

  const subscription = await tx.tenantSubscription.findUnique({
    where: { tenantId },
    select: { package: { select: { id: true, currencyCode: true } } },
  });
  const rates = subscription
    ? ((await packageMeterRatesAt(tx, new Map([[subscription.package.id, subscription.package.currencyCode]]), startsAt)).get(subscription.package.id) ?? [])
    : [];

  const locked: GrantMeterTerms[] = [];
  let onPlatform: boolean | undefined;
  for (const meter of meters) {
    const rate = rates.find((r) => r.meterKey === meter.meterKey);
    if (!rate) {
      onPlatform ??= await onPlatformPanel(tx, sale.panelGroupId);
      if (onPlatform) return { meters: [], missing: meter.meterKey };
      locked.push(meter);
      continue;
    }
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
