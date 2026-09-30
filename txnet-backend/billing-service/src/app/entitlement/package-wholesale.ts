import { Grant, GrantStatus, GrantWholesale, Prisma, TenantBillingReasonType, TenantType, VariantBillingMode } from '@prisma/client';
import { METER_KEYS, packageMeterRatesAt, TenantBillingLedger } from '@txnet-backend/shared-core';

import { onPlatformPanel } from '../traffic/vpn-wholesale';
import { CENT, max, min, priceUnits, toAmount, toCents, unitsCovered, ZERO, type Priced } from '../usage/usage-price';
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
 * An unlimited plan has no bag, so it buys its days instead (F-118-z, D-59
 * (c)): the package's `vpn.unlimited.time` rate — a flat price per period,
 * `unitSize` seconds — times the days sold, rounded up to a cent, at the sale
 * at every renewal and at every day an admin adds. Its leg's `billed` counts
 * seconds; at close the days left to its end come back, priced down, never
 * more than were bought. A plan with no end is refused on a platform panel
 * (`wholesale_rate_missing`): there is no period to price.
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
 * A plan sold with no leg locks one at its next renewal (F-118-ab, D-59
 * (e)); the bag it still held is `inherited`, never charged nor given back.
 *
 * Refusals are returned, not thrown: `EntitlementRefused` lives in `grant.ts`,
 * which calls this. The caller throws, so a refusal rolls the sale back.
 */

/** Why a sale or a raise is refused: the package prices no VPN traffic on a platform panel, or the reseller cannot pay. */
export type PackageWholesaleRefusal = 'wholesale_rate_missing' | 'wholesale_unfunded';

type Plan = Pick<Grant, 'id' | 'tenantId' | 'variantId' | 'billingMode' | 'trafficUnlimited' | 'purchasedBytes' | 'consumedBytes' | 'startsAt' | 'endsAt'>;

const SECOND_MS = 1000;
const DAY_S = BigInt(86_400);

const CLOSED: ReadonlySet<GrantStatus> = new Set([GrantStatus.expired, GrantStatus.cancelled, GrantStatus.exhausted]);

const rateOf = (leg: GrantWholesale): Priced => ({ unitSize: leg.unitSize, unitPrice: leg.unitPrice, includedQuantity: ZERO });

/** A leg that buys days, not bytes (F-118-z): no bag to settle, nothing at close. */
const isTime = (leg: GrantWholesale) => leg.meterKey === METER_KEYS.unlimitedTime;

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
    const leg = await this.lock(tx, grant, at, ZERO);
    if (leg === null) return null;
    if (typeof leg === 'string') return leg;
    if (!grant.trafficUnlimited) return this.settle(tx, grant.id, grant.id);
    const sold = BigInt(Math.ceil(((grant.endsAt as Date).getTime() - grant.startsAt.getTime()) / SECOND_MS));
    return this.buyTime(tx, leg, grant.variantId, sold, grant.id);
  }

  /**
   * A plan sold with no leg — before F-118-p, or with no rate on its own
   * panels — locks the package's rate in force at its renewal `at` (F-118-ab,
   * D-59 (e)), before the renewal moves the plan, and is charged from there on
   * by the renewal's own `settle` / `renew`. Nothing for the past: the bag
   * left from before is `inherited` — counted as bought, so only what the
   * renewal adds is charged, and never given back at close. An unlimited plan
   * inherits nothing: its days left come first, so the close's `min` already
   * keeps them. The sale's checks hold: no rate on a platform panel is
   * `wholesale_rate_missing`. A permanent unlimited plan's renewal sells no
   * days and locks nothing.
   */
  async lockAtRenewal(tx: Prisma.TransactionClient, grant: Omit<Plan, 'startsAt'>, at: Date): Promise<PackageWholesaleRefusal | null> {
    if (grant.billingMode !== VariantBillingMode.prepaid) return null;
    if (grant.trafficUnlimited && grant.endsAt === null) return null;
    if (await tx.grantWholesale.findUnique({ where: { grantId: grant.id } })) return null;
    const inherited = grant.trafficUnlimited ? ZERO : max(ZERO, grant.purchasedBytes - grant.consumedBytes);
    const leg = await this.lock(tx, grant, at, inherited);
    return typeof leg === 'string' ? leg : null;
  }

  /**
   * A renewal of an unlimited plan buys the days it adds (F-118-z), one
   * `metered_usage_charge` naming `referenceId` (the renewal's record). Nothing
   * for a bag's leg (its raise is `settle`), a Grant with no leg, or a group of
   * the reseller's own panels today.
   */
  renew(tx: Prisma.TransactionClient, grantId: string, days: number, referenceId: string): Promise<PackageWholesaleRefusal | null> {
    return this.extend(tx, grantId, BigInt(days) * DAY_S, referenceId);
  }

  /**
   * `seconds` added to an unlimited plan's end — a renewal's days, or an
   * admin's move of the end (`duration.ts`, naming its `grant_duration_change`)
   * — bought as at the sale. A cut buys nothing and gives nothing back until
   * close, where the days left are what comes back.
   */
  async extend(tx: Prisma.TransactionClient, grantId: string, seconds: bigint, referenceId: string): Promise<PackageWholesaleRefusal | null> {
    if (seconds <= ZERO) return null;
    const leg = await tx.grantWholesale.findUnique({ where: { grantId } });
    if (!leg || !isTime(leg)) return null;
    const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { variantId: true } });
    if (!grant) return null;
    return this.buyTime(tx, leg, grant.variantId, seconds, referenceId);
  }

  /**
   * After the bag moved: buy what it leaves owed, one `metered_usage_charge`
   * naming `referenceId` (the sale's Grant, or the `quota_adjustment` that
   * raised it). Nothing when the Grant has no leg or the cursor covers it.
   */
  async settle(tx: Prisma.TransactionClient, grantId: string, referenceId: string): Promise<PackageWholesaleRefusal | null> {
    const leg = await tx.grantWholesale.findUnique({ where: { grantId } });
    if (!leg || isTime(leg)) return null;
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
   * An unlimited plan's leg gives back its days left at `at` instead (F-118-z).
   */
  async settleAtClose(tx: Prisma.TransactionClient, grantId: string, at: Date = new Date()): Promise<bigint> {
    const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { status: true, endsAt: true } });
    if (!grant || !CLOSED.has(grant.status)) return ZERO;
    const leg = await tx.grantWholesale.findUnique({ where: { grantId } });
    if (!leg) return ZERO;
    if (isTime(leg)) return this.giveBackDays(tx, leg, grant.endsAt, at);
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
    // Bytes held from before the leg (F-118-ab) are served first and never come back.
    const kept = max(leg.consumed, leg.inherited);
    const left = leg.billed - kept;
    if (left <= ZERO) return ZERO;
    const cents = (left * priceUnits(rate)) / (rate.unitSize * CENT);
    if (cents === ZERO) return ZERO;
    await this.moveCursor(tx, leg, kept);
    await this.ledger.credit(tx, {
      tenantId: leg.payerTenantId,
      amount: toAmount(cents),
      currencyCode: leg.currencyCode,
      reasonType: TenantBillingReasonType.metered_usage_refund,
      referenceId: grantId,
    });
    return ZERO;
  }

  /**
   * At close, an unlimited plan's seconds left to its end — no more than
   * `billed` — back as `metered_usage_refund` naming the Grant, priced
   * **down**. `consumed` is raised to the lowered `billed`: on a time leg that
   * equality means settled, so a second close moves nothing. Nothing is ever
   * left unpaid here, so it answers 0.
   */
  private async giveBackDays(tx: Prisma.TransactionClient, leg: GrantWholesale, endsAt: Date | null, at: Date): Promise<bigint> {
    if (leg.consumed === leg.billed) return ZERO;
    const left = endsAt ? max(ZERO, BigInt(Math.floor((endsAt.getTime() - at.getTime()) / SECOND_MS))) : ZERO;
    const back = min(left, leg.billed);
    const kept = leg.billed - back;
    const { count } = await tx.grantWholesale.updateMany({
      where: { id: leg.id, billed: leg.billed, consumed: leg.consumed },
      data: { billed: kept, consumed: kept },
    });
    if (count !== 1) throw new Error(`grant_wholesale ${leg.id}: billed moved`);
    const rate = rateOf(leg);
    const cents = (back * priceUnits(rate)) / (rate.unitSize * CENT);
    if (cents === ZERO) return ZERO;
    await this.ledger.credit(tx, {
      tenantId: leg.payerTenantId,
      amount: toAmount(cents),
      currencyCode: leg.currencyCode,
      reasonType: TenantBillingReasonType.metered_usage_refund,
      referenceId: leg.grantId,
    });
    return ZERO;
  }

  /**
   * `seconds` of an unlimited plan, priced **up** to a cent when the group
   * holds a platform panel now; the cursor moves by the seconds sold.
   */
  private async buyTime(tx: Prisma.TransactionClient, leg: GrantWholesale, variantId: string | null, seconds: bigint, referenceId: string): Promise<PackageWholesaleRefusal | null> {
    if (seconds <= ZERO || variantId === null || !(await onPlatformPanel(tx, variantId))) return null;
    const cents = priceOf(rateOf(leg), seconds);
    const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId: leg.payerTenantId } });
    if (cents > toCents(wallet?.cachedBalance ?? new Prisma.Decimal(0))) return 'wholesale_unfunded';
    await this.moveCursor(tx, leg, leg.billed + seconds);
    if (cents === ZERO) return null;
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
   * A reseller's prepaid plan locks its package's rate in force at `at`: the
   * leg, `billed` starting at `inherited` (F-118-ab). Null for a sale that
   * has none — the platform's own, a metered Grant, an empty bag, or no rate
   * on the reseller's own panels; a refusal for no rate on a platform panel.
   */
  private async lock(tx: Prisma.TransactionClient, grant: Omit<Plan, 'startsAt'>, at: Date, inherited: bigint): Promise<GrantWholesale | PackageWholesaleRefusal | null> {
    if (grant.billingMode !== VariantBillingMode.prepaid) return null;
    if (!grant.trafficUnlimited && grant.purchasedBytes <= ZERO) return null;
    const tenant = await tx.tenant.findUnique({ where: { id: grant.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.reseller) return null;

    const meterKey = grant.trafficUnlimited ? METER_KEYS.unlimitedTime : METER_KEYS.vpnTraffic;
    const rate = await this.rateAt(tx, grant.tenantId, meterKey, at);
    // An unlimited plan with no end has no period to price: on a platform panel it is as unpriced.
    const priced = rate && (!grant.trafficUnlimited || grant.endsAt !== null) ? rate : null;
    if (!priced) return (await onPlatformPanel(tx, grant.variantId)) ? 'wholesale_rate_missing' : null;
    return tx.grantWholesale.create({
      data: {
        tenantId: grant.tenantId,
        grantId: grant.id,
        payerTenantId: grant.tenantId,
        rateId: priced.id,
        meterKey,
        unitSize: priced.unitSize,
        unitPrice: priced.unitPrice,
        currencyCode: priced.currencyCode,
        billed: inherited,
        inherited,
      },
    });
  }

  /** The reseller's package rate for `meterKey` in force at `at`, or null. */
  private async rateAt(tx: Prisma.TransactionClient, tenantId: string, meterKey: string, at: Date) {
    const subscription = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: { package: { select: { id: true, currencyCode: true } } },
    });
    if (!subscription) return null;
    const { id, currencyCode } = subscription.package;
    const rates = (await packageMeterRatesAt(tx, new Map([[id, currencyCode]]), at)).get(id) ?? [];
    return rates.find((r) => r.meterKey === meterKey) ?? null;
  }

  private async moveCursor(tx: Prisma.TransactionClient, leg: GrantWholesale, to: bigint): Promise<void> {
    const { count } = await tx.grantWholesale.updateMany({ where: { id: leg.id, billed: leg.billed }, data: { billed: to } });
    // A settle racing another on one Grant: the Grant row's own guard sends the caller back to retry.
    if (count !== 1) throw new Error(`grant_wholesale ${leg.id}: billed moved`);
  }
}
