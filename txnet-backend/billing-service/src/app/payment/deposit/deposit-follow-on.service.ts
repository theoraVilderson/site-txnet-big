import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfirmationSource, PaymentStatus, Prisma, ReconciliationAction } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DepositSettlementService, GatewayReceipt, PAYMENT_SELECT, PaymentRow } from './deposit-settlement';

/**
 * Money that arrives for an invoice already settled (F-104-s, ADR-0068).
 *
 * One provider invoice can hold several payments — `nowpayments.provider.ts`
 * says so itself, which is why its `expired` and `failed` are pending — so a
 * payer who covers a short payment with a second transfer, or pays the same
 * invoice again in another coin, sends money against a row that is already
 * `success`. That money is in the merchant account; until this service it was
 * in nothing else, because `deposit-webhook.service.ts`'s `if (!open) return;`
 * dropped the event without a credit, a log or a flag.
 *
 * **A payment row holds one settlement, and that stays true.** `amountCredited`,
 * `gatewayReferenceId` and `amountReceivedMinor` are each one figure, and
 * `creditVerified` is a `pending -> success` flip. So a second arrival is not a
 * second settlement of the old row: it is **a payment of its own** — a new
 * `payment_transaction` for the same user at the same gateway, carrying the
 * transfer's own reference as its `gatewayTrackingCode`, settled through the
 * one settlement path. The ledger row, the outbox event, the gateway accrual
 * and the panel's history page then need no new code at all.
 *
 * **The reference is the guard, and the unique index is the guard under it.**
 * A provider repeats a delivery; NOWPayments repeats it for days. The transfer
 * reference is what distinguishes the second payment from the first one told
 * twice, and `@@unique([gateway column, gatewayTrackingCode])` (ADR-0028) makes
 * a race between two deliveries a refused write rather than a doubled credit.
 *
 * **It carries no coupon.** The discount was bought by the first payment (the
 * `contract.webhook.md` rule: a coupon applies only to a full payment), so a
 * follow-on credits what arrived net of the gateway's cut and nothing more.
 *
 * **What it cannot value, it flags** — a `payment_reconciliation_log` row on
 * the original invoice, which is what `deposit-reconciliation.service.ts`
 * already means by `flagged_mismatch`: recorded for a person, never guessed at.
 * A credited one is logged there too, so the settled invoice names the payment
 * it grew.
 */

/** What a provider's signed `paid` brought for an invoice that is already closed. */
export type FollowOnArrival = {
  /** The transfer's own id at the provider — `payment_id`, `tx_hash`, an attempt id. */
  referenceId: string;
  /** What the provider says arrived, when it says. Its currency is the driver's charge currency. */
  received?: GatewayReceipt;
  /** The driver's minor unit, for an arrival reported as none: the invoice's own charge. */
  chargeDecimals: number;
};

/**
 * `credited` wrote a payment and credited the wallet; `duplicate` is a delivery
 * already taken, which is the ordinary case; `flagged` left a log row for a
 * person and no money.
 */
export type FollowOnOutcome = 'credited' | 'duplicate' | 'flagged';

const floor2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);

/**
 * What arriving money is worth, and what of it is the gateway's (F-104-s).
 *
 * The same rule as a short receipt (F-104-r): `chargedAmountMinor` at the
 * frozen rate is `amountCredited` *plus* `feeApplied` — the cut the payer
 * covered inside the charge — so the cut comes out of the arrival in the
 * proportion that arrived, and what is left is the credit. At a full charge
 * that is the whole charge net of the fee, which is deliberately **not**
 * `amountCredited`: that figure carries the first payment's discount.
 *
 * `null` means it cannot be valued, and the caller flags instead of guessing: a
 * row with no usable rate (the free path), a fee at or above the whole charge,
 * or an arrival worth under a cent.
 */
export function followOnCredit(
  original: Pick<PaymentRow, 'feeApplied' | 'chargedAmountMinor' | 'exchangeRateSnapshot'>,
  arrivedMinor: bigint,
  decimals: number,
): { credited: Prisma.Decimal; fee: Prisma.Decimal } | null {
  const rate = original.exchangeRateSnapshot;
  const charged = original.chargedAmountMinor;
  if (!rate || rate.lte(0) || charged <= BigInt(0) || arrivedMinor <= BigInt(0)) return null;

  const toBase = (minor: bigint) =>
    new Prisma.Decimal(minor.toString()).div(new Prisma.Decimal(10).pow(decimals)).div(rate);
  const net = toBase(charged).minus(original.feeApplied);
  if (net.lte(0)) return null;

  const share = new Prisma.Decimal(arrivedMinor.toString()).div(charged.toString());
  const credited = floor2(net.times(share));
  if (credited.lte(0)) return null;
  const gross = floor2(toBase(arrivedMinor));
  const fee = gross.minus(credited);
  return { credited, fee: fee.lt(0) ? new Prisma.Decimal(0) : fee };
}

@Injectable()
export class DepositFollowOnService {
  private readonly logger = new Logger(DepositFollowOnService.name);

  constructor(
    private readonly prisma: PrismaService,
    // A reseller's billing top-up settles on the owner's pool, for the reason
    // `creditVerified` gives (ADR-0053); its follow-on is written on the same.
    private readonly all: CrossTenantPrismaService,
    private readonly settlement: DepositSettlementService,
  ) {}

  /** Runs in the payment's own tenant, as the webhook door opened it. */
  async take(original: PaymentRow, arrival: FollowOnArrival): Promise<FollowOnOutcome> {
    // The transfer that settled the invoice, told again. Every provider does it.
    if (arrival.referenceId === original.gatewayReferenceId) return 'duplicate';

    const column = original.gatewayId ? ('gatewayId' as const) : ('tenantGatewayConfigId' as const);
    const gatewayId = original.gatewayId ?? original.tenantGatewayConfigId;
    if (!gatewayId) return 'duplicate';

    const decimals = arrival.received?.decimals ?? arrival.chargeDecimals;
    const arrivedMinor = arrival.received?.amountMinor ?? original.chargedAmountMinor;
    const value = followOnCredit(original, arrivedMinor, decimals);
    if (!value) {
      await this.flag(original, arrival, 'the arrival cannot be valued at this payment’s rate');
      return 'flagged';
    }

    const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      original.billingTenantId ? this.all.$transaction(fn) : tenantTransaction(this.prisma, fn);

    const id = randomUUID();
    let made: PaymentRow | null;
    try {
      made = await run(async (tx) => {
        const taken = await tx.paymentTransaction.findFirst({
          where: { [column]: gatewayId, gatewayTrackingCode: arrival.referenceId },
          select: { id: true },
        });
        if (taken) return null;
        await tx.paymentTransaction.create({
          data: {
            id,
            userId: original.userId,
            [column]: gatewayId,
            // The payment this one is money for: the same gateway, the same
            // grant, the same wallet. Only the coupons are not inherited.
            grantId: original.grantId,
            billingTenantId: original.billingTenantId,
            amountRequested: value.credited,
            feeApplied: value.fee,
            amountCredited: value.credited,
            currencyCode: original.currencyCode,
            chargedAmountMinor: arrivedMinor,
            // The invoice's own rate: the arrival is money for the price that
            // invoice quoted, and every driver that settles by webhook charges
            // the base currency, so the pair is 1 and nothing is stale.
            exchangeRateSnapshot: original.exchangeRateSnapshot,
            exchangeRateSnapshotId: original.exchangeRateSnapshotId ?? null,
            status: PaymentStatus.pending,
            // Already due: the credit follows immediately, and a row stranded
            // by a crash between the two is closed by the expiry sweep instead
            // of sitting `pending` for ever. `creditVerified` takes `expired`.
            expiresAt: new Date(),
            channel: original.channel,
            gatewayTrackingCode: arrival.referenceId,
          },
          select: { id: true },
        });
        return tx.paymentTransaction.findFirst({ where: { id }, select: PAYMENT_SELECT });
      });
    } catch (e) {
      // The unique index refused it: another delivery of the same transfer got
      // there first, which is the answer, not an error (ADR-0028).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'duplicate';
      throw e;
    }
    if (!made) return 'duplicate';

    const credited = await this.settlement.creditVerified(
      made,
      {
        referenceId: arrival.referenceId,
        cardPan: null,
        ...(arrival.received ? { received: arrival.received } : {}),
      },
      ConfirmationSource.webhook_auto,
    );
    if (!credited) {
      // The row was written and the flip did not take. Nothing will come back
      // for it, so a person is told rather than a sweep asked: the driver here
      // answers `unavailable` to every inquiry.
      await this.flag(original, arrival, `payment ${id} was written for it and did not settle`);
      return 'flagged';
    }
    this.logger.warn(
      `payment ${original.id} is settled and ${arrival.referenceId} arrived for it: payment ${id} credited ${value.credited}`,
    );
    await this.record(
      original,
      ReconciliationAction.auto_confirmed,
      `${arrival.referenceId} arrived for this settled invoice; payment ${id} credited ${value.credited}`,
    );
    return 'credited';
  }

  private async flag(original: PaymentRow, arrival: FollowOnArrival, why: string): Promise<void> {
    this.logger.warn(`payment ${original.id} is settled and ${arrival.referenceId} arrived for it: ${why}`);
    await this.record(original, ReconciliationAction.flagged_mismatch, `${arrival.referenceId}: ${why}`);
  }

  /**
   * The audit row, on the **invoice** — the row a person looking at this
   * top-up reads. `gatewayReportedStatus` is what happened in the provider's
   * terms, as `deposit-reconciliation.service.ts` writes it.
   */
  private async record(original: PaymentRow, action: ReconciliationAction, notes: string): Promise<void> {
    await tenantTransaction(this.prisma, (tx) =>
      tx.paymentReconciliationLog.create({
        data: { paymentTransactionId: original.id, gatewayReportedStatus: 'paid_after_settlement', actionTaken: action, notes },
        select: { id: true },
      }),
    );
  }
}
