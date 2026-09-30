import { Grant, GrantStatus, GrantWholesale, Prisma, TenantBillingReasonType, TenantType, VariantBillingMode } from '@prisma/client';
import { METER_KEYS, packageMeterRatesAt, TenantBillingLedger } from '@txnet-backend/shared-core';

import { onPlatformPanel } from '../traffic/vpn-wholesale';
import { CENT, max, priceUnits, toAmount, toCents, unitsCovered, ZERO, type Priced } from '../usage/usage-price';
import { coverable, priceOf } from '../usage/usage-wholesale';

/**
 * A reseller's package plan, bought wholesale (F-118-p, ADR-0105 decision 0
 * amended 2026-09-29). A plan paid in full has no meter, and its user's path
 * stays exactly that; only the reseller's side is added. The bag its user
 * bought is charged at the package's `vpn.traffic` rate on the reseller's
 * `tenant_billing_wallet`, at the sale and at every raise of the bag, and at
 * close what no platform panel served comes back, or what one served past the
 * cursor is charged (F-118-y).
 *
 * `billed` is the cursor, over `consumed` — the bytes served on **platform**
 * panels (`metering-service`). After the bag moves it is owed to
 *
 *     consumed + bytes left in the bag      (group has a platform panel)
 *     consumed                              (its own panels only)
 *
 * and never comes down before close: a byte bought ahead and served by the
 * reseller's own panel funds the next platform byte instead. F-118-n3's rule
 * for a metered block, on a bag bought whole.
 *
 * Refusals are returned, not thrown: `EntitlementRefused` lives in `grant.ts`,
 * which calls this. The caller throws, so a refusal rolls the sale back.
 */

/** Why a sale or a raise is refused: the package prices no VPN traffic on a platform panel, or the reseller cannot pay. */
export type PackageWholesaleRefusal = 'wholesale_rate_missing' | 'wholesale_unfunded';

type Plan = Pick<Grant, 'id' | 'tenantId' | 'variantId' | 'billingMode' | 'trafficUnlimited' | 'purchasedBytes' | 'consumedBytes'>;

const CLOSED: ReadonlySet<GrantStatus> = new Set([GrantStatus.expired, GrantStatus.cancelled, GrantStatus.exhausted]);

const rateOf = (leg: GrantWholesale): Priced => ({ unitSize: leg.unitSize, unitPrice: leg.unitPrice, includedQuantity: ZERO });

export class PackageWholesale {
  constructor(private readonly ledger: TenantBillingLedger = new TenantBillingLedger()) {}

  /**
   * At issue: a reseller's limited plan locks its package's `vpn.traffic` rate
   * in force at `at` and buys its bag, the charge naming the Grant. Locked
   * whatever the group holds today — members change after the sale — but a
   * package with no rate refuses only a group holding a platform panel; on its
   * own panels the reseller sells as before, with no leg.
   */
  async open(tx: Prisma.TransactionClient, grant: Plan, at: Date): Promise<PackageWholesaleRefusal | null> {
    if (grant.billingMode !== VariantBillingMode.prepaid || grant.trafficUnlimited || grant.purchasedBytes <= ZERO) return null;
    const tenant = await tx.tenant.findUnique({ where: { id: grant.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.reseller) return null;

    const rate = await this.rateAt(tx, grant.tenantId, at);
    if (!rate) return (await onPlatformPanel(tx, grant.variantId)) ? 'wholesale_rate_missing' : null;
    await tx.grantWholesale.create({
      data: {
        tenantId: grant.tenantId,
        grantId: grant.id,
        payerTenantId: grant.tenantId,
        rateId: rate.id,
        unitSize: rate.unitSize,
        unitPrice: rate.unitPrice,
        currencyCode: rate.currencyCode,
      },
    });
    return this.settle(tx, grant.id, grant.id);
  }

  /**
   * After the bag moved: buy what it leaves owed, one `metered_usage_charge`
   * naming `referenceId` (the sale's Grant, or the `quota_adjustment` that
   * raised it). Nothing when the Grant has no leg or the cursor covers it.
   */
  async settle(tx: Prisma.TransactionClient, grantId: string, referenceId: string): Promise<PackageWholesaleRefusal | null> {
    const leg = await tx.grantWholesale.findUnique({ where: { grantId } });
    if (!leg) return null;
    const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { variantId: true, purchasedBytes: true, consumedBytes: true } });
    if (!grant) return null;

    const ahead = (await onPlatformPanel(tx, grant.variantId)) ? max(ZERO, grant.purchasedBytes - grant.consumedBytes) : ZERO;
    const short = leg.consumed + ahead - leg.billed;
    if (short <= ZERO) return null;

    const rate = rateOf(leg);
    const cents = priceOf(rate, short);
    const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId: leg.payerTenantId } });
    if (cents > toCents(wallet?.cachedBalance ?? new Prisma.Decimal(0))) return 'wholesale_unfunded';

    // Every byte the rounded-up cents pay for: the cursor never lags the money.
    await this.moveCursor(tx, leg, leg.billed + unitsCovered(rate, cents));
    await this.ledger.debit(tx, {
      tenantId: leg.payerTenantId,
      amount: toAmount(cents),
      currencyCode: leg.currencyCode,
      reasonType: TenantBillingReasonType.metered_usage_charge,
      referenceId,
    });
    return null;
  }

  /**
   * At close, both ways (F-118-y): bytes bought and never served on a platform
   * panel back as `metered_usage_refund` naming the Grant, priced down, the
   * cursor to `consumed`; or bytes a platform panel served past the cursor (one
   * added to the group after the last raise) charged as `metered_usage_charge`,
   * up to the reseller's balance. Answers the bytes it could not charge — they
   * stay below the cursor, never a negative wallet. The cursor is the guard,
   * so a second close moves nothing; an open Grant, or one with no leg, neither.
   */
  async settleAtClose(tx: Prisma.TransactionClient, grantId: string): Promise<bigint> {
    const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { status: true } });
    if (!grant || !CLOSED.has(grant.status)) return ZERO;
    const leg = await tx.grantWholesale.findUnique({ where: { grantId } });
    if (!leg) return ZERO;
    const rate = rateOf(leg);
    if (leg.consumed > leg.billed) {
      const short = leg.consumed - leg.billed;
      const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId: leg.payerTenantId } });
      const plan = coverable(rate, short, toCents(wallet?.cachedBalance ?? new Prisma.Decimal(0)));
      if (plan.units > ZERO) {
        await this.moveCursor(tx, leg, leg.billed + plan.units);
        await this.ledger.debit(tx, {
          tenantId: leg.payerTenantId,
          amount: toAmount(plan.cents),
          currencyCode: leg.currencyCode,
          reasonType: TenantBillingReasonType.metered_usage_charge,
          referenceId: grantId,
        });
      }
      return short - plan.units;
    }
    const left = leg.billed - leg.consumed;
    if (left <= ZERO) return ZERO;
    const cents = (left * priceUnits(rate)) / (rate.unitSize * CENT);
    if (cents === ZERO) return ZERO;
    await this.moveCursor(tx, leg, leg.consumed);
    await this.ledger.credit(tx, {
      tenantId: leg.payerTenantId,
      amount: toAmount(cents),
      currencyCode: leg.currencyCode,
      reasonType: TenantBillingReasonType.metered_usage_refund,
      referenceId: grantId,
    });
    return ZERO;
  }

  /** The reseller's package rate for `vpn.traffic` in force at `at`, or null. */
  private async rateAt(tx: Prisma.TransactionClient, tenantId: string, at: Date) {
    const subscription = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: { package: { select: { id: true, currencyCode: true } } },
    });
    if (!subscription) return null;
    const { id, currencyCode } = subscription.package;
    const rates = (await packageMeterRatesAt(tx, new Map([[id, currencyCode]]), at)).get(id) ?? [];
    return rates.find((r) => r.meterKey === METER_KEYS.vpnTraffic) ?? null;
  }

  private async moveCursor(tx: Prisma.TransactionClient, leg: GrantWholesale, to: bigint): Promise<void> {
    const { count } = await tx.grantWholesale.updateMany({ where: { id: leg.id, billed: leg.billed }, data: { billed: to } });
    // A settle racing another on one Grant: the Grant row's own guard sends the caller back to retry.
    if (count !== 1) throw new Error(`grant_wholesale ${leg.id}: billed moved`);
  }
}
