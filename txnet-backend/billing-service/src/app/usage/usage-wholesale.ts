import { GrantMeter, Prisma, TenantBillingReasonType } from '@prisma/client';
import type { TenantBillingLedger } from '@txnet-backend/shared-core';

import { blockFor, ceilDiv, CENT, priceUnits, toAmount, toCents, ZERO, type Priced } from './usage-price';

/**
 * The reseller's side of a per-use door (F-118-h, ADR-0105 (10), §14.5): the
 * units its user is about to use, bought on its `tenant_billing_wallet` at the
 * wholesale rate its Grant locked (F-118-n2) — prepaid whatever the user's
 * mode — and the units no open token needs given back. Its own file because
 * it moves the reseller's ledger, never a user's: `WalletCreditService` owns
 * every user-wallet credit (`entitlement/revival.spec.ts`).
 *
 * `wholesaleBilled` is its cursor over the meter's `consumed`. There is no
 * included part: the package rate prices every unit (F-118-n1).
 */

export type WholesalePlan = { units: bigint; cents: bigint };

/** The locked rate, in the engine's shape. */
const rateOf = (m: GrantMeter): Priced => ({ unitSize: m.wholesaleUnitSize!, unitPrice: m.wholesaleUnitPrice!, includedQuantity: ZERO });

/** The price of `units`, rounded **up** to a cent: what a block for them costs. */
export const priceOf = (rate: Priced, units: bigint): bigint => ceilDiv(units * priceUnits(rate), rate.unitSize * CENT);

/** Why the reseller cannot pay. */
export class WholesaleUnfunded extends Error {
  constructor(readonly balance: Prisma.Decimal) {
    super(`the reseller's billing wallet cannot buy the wholesale units (${balance.toString()})`);
    this.name = 'WholesaleUnfunded';
  }
}

/** A cursor move that raced another; nothing was written. */
export class WholesaleCursorMoved extends Error {
  constructor(readonly meterId: string) {
    super(`wholesaleBilled of grant_meter ${meterId} moved`);
    this.name = 'WholesaleCursorMoved';
  }
}

export class WholesaleLeg {
  constructor(private readonly ledger: TenantBillingLedger) {}

  /** What the reseller must buy for `need` units, all or nothing; null when it owes nothing more. Reads only. */
  async plan(tx: Prisma.TransactionClient, meter: GrantMeter, need: bigint): Promise<WholesalePlan | null> {
    if (!meter.wholesalePayerTenantId) return null;
    const short = need - meter.wholesaleBilled;
    if (short <= ZERO) return null;
    const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId: meter.wholesalePayerTenantId } });
    const balance = wallet?.cachedBalance ?? new Prisma.Decimal(0);
    const rate = rateOf(meter);
    if (priceOf(rate, short) > toCents(balance)) throw new WholesaleUnfunded(balance);
    return blockFor(rate, short, balance);
  }

  /** `wholesaleBilled` up by the plan, guarded on the value read, then one `metered_usage_charge` for the token. */
  async buy(tx: Prisma.TransactionClient, meter: GrantMeter, plan: WholesalePlan, tokenId: string): Promise<void> {
    await this.moveCursor(tx, meter, meter.wholesaleBilled + plan.units);
    await this.ledger.debit(tx, {
      tenantId: meter.wholesalePayerTenantId!,
      amount: toAmount(plan.cents),
      currencyCode: meter.wholesaleCurrencyCode!,
      reasonType: TenantBillingReasonType.metered_usage_charge,
      referenceId: tokenId,
    });
  }

  /** Units bought past `usedTo`, priced **down**, back as `metered_usage_refund`; under a cent moves nothing. */
  async giveBack(tx: Prisma.TransactionClient, meter: GrantMeter, usedTo: bigint, tokenId: string): Promise<void> {
    if (!meter.wholesalePayerTenantId) return;
    const left = meter.wholesaleBilled - usedTo;
    if (left <= ZERO) return;
    const rate = rateOf(meter);
    const cents = (left * priceUnits(rate)) / (rate.unitSize * CENT);
    if (cents === ZERO) return;
    await this.moveCursor(tx, meter, usedTo);
    await this.ledger.credit(tx, {
      tenantId: meter.wholesalePayerTenantId,
      amount: toAmount(cents),
      currencyCode: meter.wholesaleCurrencyCode!,
      reasonType: TenantBillingReasonType.metered_usage_refund,
      referenceId: tokenId,
    });
  }

  private async moveCursor(tx: Prisma.TransactionClient, meter: GrantMeter, to: bigint): Promise<void> {
    const { count } = await tx.grantMeter.updateMany({ where: { id: meter.id, wholesaleBilled: meter.wholesaleBilled }, data: { wholesaleBilled: to } });
    if (count !== 1) throw new WholesaleCursorMoved(meter.id);
  }
}
