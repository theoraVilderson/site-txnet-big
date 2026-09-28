import { Injectable, Logger } from '@nestjs/common';
import {
  ConfirmationSource,
  PaymentStatus,
  Prisma,
  RedemptionStatus,
  TenantBillingReasonType,
  WalletReasonType,
} from '@prisma/client';
import { OutboxEventType, TenantBillingLedger, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletCreditService } from '../../wallet/wallet-credit.service';
import { CouponReservationService } from '../coupon/coupon-reservation';
import { GatewaySource, MerchantGatewayRef } from '../gateway/gateway-merchant';

/**
 * The moment a top-up becomes money, and the only place it happens (F-092-j,
 * F-092-l).
 *
 * There are two ways to learn that a gateway took a payment — the payer comes
 * back and the callback asks (`deposit-callback.service.ts`), or nobody came
 * back and reconciliation asks later (`deposit-reconciliation.service.ts`) —
 * and exactly one way to act on it. This is that one way, extracted when the
 * second caller arrived rather than spelled twice: the flip, the credit, the
 * coupon confirm and the outbox event, in one transaction, guarded by the row's
 * own status.
 *
 * **The flip is the guard.** `updateMany({ where: { id, status: pending } })`
 * — or `expired`, for a payment the bank confirms after its clock (F-092-aa) —
 * with everything else hanging off its `count` — never off a status read a
 * moment earlier. A bank redirecting twice, a retried webhook and a
 * reconciliation run racing the payer all see `pending`, and Postgres re-checks
 * that `where` after the loser waits on the winner's row lock, so the wallet
 * grows once (ADR-0028, invariant 7).
 *
 * **The event commits with the money** (ADR-0021): written inside the same
 * transaction, so there is no window where a wallet grew and nothing was
 * announced.
 *
 * What differs between the two callers is one enum — `webhook_auto` when a
 * payer's browser brought the answer, `reconciliation_auto` when a sweep went
 * and asked — and that is the only thing this takes from them.
 */

/** What the row is selected as. No secret column is ever on this list (invariant 8). */
export const PAYMENT_SELECT = {
  id: true,
  userId: true,
  status: true,
  gatewayId: true,
  tenantGatewayConfigId: true,
  amountCredited: true,
  // What every amount on it is in (F-116-b): the wallet credit and the accrual are too.
  currencyCode: true,
  // The gateway's own cut, which the payer covered. A granted gateway's
  // accrual is net of it (ADR-0041 §4, F-096-d).
  feeApplied: true,
  chargedAmountMinor: true,
  // The frozen rate a receipt for another amount is valued at (F-104-d), and
  // which reading it was: a follow-on payment is written at the same rate and legs, and
  // a rate without its snapshot is the state invariant 12 forbids (F-104-s).
  exchangeRateSnapshot: true,
  exchangeRateSnapshotId: true,
  exchangeRateFromSnapshotId: true,
  // The authority. The callback arrives holding one; reconciliation has to read
  // it off the row, because nothing brought it (F-092-l).
  gatewayTrackingCode: true,
  // Authorities offered while it has none (F-092-ag): what reconciliation asks
  // about when the row carries no authority of its own.
  authorityCandidates: true,
  gatewayReferenceId: true,
  // The grant it was taken under, or NULL (F-096-a). Settling and reconciling
  // both charge the same gateway the payment was started at, so both read the
  // credential along the same grant (ADR-0041 §3).
  grantId: true,
  // A reseller's billing top-up (F-019-b, ADR-0056): the wallet credited is
  // this tenant's with the platform, not the payer's.
  billingTenantId: true,
  // The retry clock (F-092-x): the rung a silence climbs from, and whether the
  // row is verifying at all.
  verifyAttempts: true,
  nextVerifyAt: true,
  // Where it was started (F-306-a): the payer notice reads it off the event.
  channel: true,
  gateway: { select: { providerName: true } },
  tenantGatewayConfig: { select: { providerName: true } },
} satisfies Prisma.PaymentTransactionSelect;

export type PaymentRow = Prisma.PaymentTransactionGetPayload<{ select: typeof PAYMENT_SELECT }>;

/** What a gateway's `verify` answered, and which of the two askers is holding it. */
export type VerifiedPayment = {
  referenceId: string;
  cardPan: string | null;
  /**
   * The authority to write in the same flip, for a payment found without one
   * (F-092-ad). The flip is then also guarded `gatewayTrackingCode: null`.
   */
  authority?: string;
  /**
   * What the gateway reports arrived, when it reports it (F-104-d, D-32).
   * `currency` is the gateway's charge currency and `decimals` its minor unit —
   * a receipt in any other asset cannot be valued at the frozen rate, and the
   * caller does not bring it here. Missing means exactly what was asked.
   */
  received?: GatewayReceipt;
  /**
   * The payer is told the result by the chat that relayed it (F-104-k, F-104-m):
   * the event says so, and the payer notice does not send a second message.
   */
  shownInChat?: boolean;
};

/** An amount the gateway says arrived, in `currency`'s minor unit of `decimals` places. */
export type GatewayReceipt = { amountMinor: bigint; currency: string; decimals: number };

/**
 * What a payment is worth in base currency, given what arrived (F-104-d, D-32:
 * credit what actually arrived). Exactly the asked amount, or no receipt, is
 * `amountCredited`. More is `amountCredited` plus the surplus at the frozen
 * rate. Every conversion floors to the cent: a fraction that did not arrive is
 * never credited. A payment with no rate (the free path) has nothing to value a
 * receipt at, and credits as asked.
 *
 * **Less is the payer's share of what the charge was actually for** (F-104-r),
 * not the receipt valued whole. `chargedAmountMinor` is `amountCredited` *plus*
 * `feeApplied` at the frozen rate — the gateway's cut, which the payer covered
 * — so valuing a short receipt whole credited that cut as if it were money the
 * platform kept. On a 5% gateway, 100.00 asked is charged 105.00, and a receipt
 * of 104.99 credited 104.99: paying one cent short paid 4.99 more than paying
 * in full. So the fee comes out in proportion to what arrived — credited =
 * (charge at the frozen rate - `feeApplied`) x received / asked — which is
 * exactly `amountCredited` at a full receipt and strictly less below it. `full`
 * is false either way: a coupon applies only to a full payment, and its
 * discount is not in this figure.
 */
export function creditForReceipt(
  payment: Pick<PaymentRow, 'amountCredited' | 'feeApplied' | 'chargedAmountMinor' | 'exchangeRateSnapshot'>,
  received: GatewayReceipt | undefined,
): { credited: Prisma.Decimal; full: boolean } {
  const asked = payment.chargedAmountMinor;
  const rate = payment.exchangeRateSnapshot;
  if (!received || received.amountMinor === asked || !rate || rate.lte(0)) {
    return { credited: payment.amountCredited, full: true };
  }
  const toBase = (minor: bigint) =>
    new Prisma.Decimal(minor.toString()).div(new Prisma.Decimal(10).pow(received.decimals)).div(rate);
  const cents = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  if (received.amountMinor < asked) {
    // The charge less the fee: what a full payment would have left the platform
    // holding. A fee at or above the whole charge leaves nothing to share out,
    // and the caller closes the row `nothing_received`.
    const net = toBase(asked).minus(payment.feeApplied);
    if (net.lte(0)) return { credited: new Prisma.Decimal(0), full: false };
    const share = new Prisma.Decimal(received.amountMinor.toString()).div(asked.toString());
    return { credited: cents(net.times(share)), full: false };
  }
  return { credited: payment.amountCredited.plus(cents(toBase(received.amountMinor - asked))), full: true };
}

/** A person's confirmation (F-092-z): who, why, and from where — the audit row's content. */
export type ManualConfirmation = { adminId: string; reason: string; ip: string };

@Injectable()
export class DepositSettlementService {
  private readonly logger = new Logger(DepositSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: CouponReservationService,
    private readonly ledger: WalletCreditService,
    private readonly all: CrossTenantPrismaService,
    private readonly tenantLedger: TenantBillingLedger,
  ) {}

  /**
   * Credit a verified payment, once.
   *
   * Answers whether **this** call was the one that did it. `false` is not a
   * failure: it means another caller won the guard and the payment is settled,
   * which is the ordinary outcome of a reload, a retried webhook, or a sweep
   * arriving a second after the payer.
   */
  async creditVerified(
    payment: PaymentRow,
    verified: VerifiedPayment,
    source: ConfirmationSource,
    /** Required with `admin_manual`, and refused without it (F-092-z). */
    manual?: ManualConfirmation,
  ): Promise<boolean> {
    if ((source === ConfirmationSource.admin_manual) !== (manual !== undefined)) {
      throw new Error('an admin_manual credit needs a ManualConfirmation, and only it may carry one');
    }
    const { credited, full } = creditForReceipt(payment, verified.received);
    // A reseller's billing top-up (F-019-b, ADR-0056) is the platform owner's
    // payment crediting another tenant's `tenant_billing_wallet`, which strict
    // RLS hides from the owner-bound app pool — so its whole settlement, flip
    // and credit together, runs on the cross-tenant pool (ADR-0053: the owner's).
    const billingTenantId = payment.billingTenantId ?? null;
    const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      billingTenantId ? this.all.$transaction(fn) : tenantTransaction(this.prisma, fn);
    return run(async (tx) => {
      // Less than a cent arrived: nothing to credit, and nothing will arrive
      // later under this authority. Closed like a failure (F-104-d).
      if (credited.lte(0)) {
        const closed = (await this.closeOpen(tx, payment, 'nothing_received')) !== null;
        if (closed) this.logger.warn(`payment ${payment.id} closed: the gateway reports under a cent arrived`);
        return false;
      }
      const receipt = verified.received
        ? { amountReceivedMinor: verified.received.amountMinor, receivedCurrency: verified.received.currency }
        : {};
      const data = {
        status: PaymentStatus.success,
        // The money of record, when what arrived differs from what was asked.
        ...(credited.eq(payment.amountCredited) ? {} : { amountCredited: credited }),
        ...receipt,
        gatewayReferenceId: verified.referenceId,
        cardPanMasked: verified.cardPan,
        confirmationSource: source,
        ...(manual ? { confirmedByAdminId: manual.adminId, manualConfirmReason: manual.reason } : {}),
        // A payment that has landed has no clock left to run out (F-092-k),
        // and nothing left to verify (F-092-x).
        expiresAt: null,
        nextVerifyAt: null,
        ...(verified.authority ? { gatewayTrackingCode: verified.authority } : {}),
      };
      // Two guards, tried in order, rather than `status: { in: [...] }`: which
      // one matched is what says whether the coupon holds are still held. A row
      // read `pending` may have been expired by the sweep since (ADR-0046
      // decision 1) — the money is paid either way, and only a settled row is
      // matched by neither.
      const flip = async (from: PaymentStatus) =>
        (
          await tx.paymentTransaction.updateMany({
            where: { id: payment.id, status: from, ...(verified.authority ? { gatewayTrackingCode: null } : {}) },
            data,
          })
        ).count === 1;
      const from = (await flip(PaymentStatus.pending))
        ? PaymentStatus.pending
        : (await flip(PaymentStatus.expired))
          ? PaymentStatus.expired
          : null;
      if (from === null) return false;
      const settled: PaymentRow = { ...payment, amountCredited: credited };

      if (billingTenantId) {
        // No coupon, no grant (the row's CHECK), and no user was credited: the
        // `billing.payment.confirmed` event means "this user's wallet grew", so
        // it is not written. The ledger row is the record (F-019-d reads it).
        await this.tenantLedger.credit(tx, {
          tenantId: billingTenantId,
          amount: credited,
          reasonType: TenantBillingReasonType.topup_payment,
          referenceId: payment.id,
        });
        if (manual) await this.auditManual(tx, settled, verified.referenceId, manual);
        this.logger.log(`payment ${payment.id} credited ${credited.toFixed(2)} to tenant ${billingTenantId}'s billing wallet`);
        return true;
      }

      await this.ledger.credit(tx, {
        userId: payment.userId,
        // `amountCredited`, which already carries the adjustment gap the quote
        // computed (`amountRequested` is what the user typed) — or
        // what a receipt for another amount made of it (F-104-d).
        amount: credited,
        currencyCode: payment.currencyCode,
        reasonType: WalletReasonType.payment_gateway,
        referenceId: payment.id,
      });
      // A pending row holds its coupon slots, and so does an expired one until
      // COUPON_HOLD_AFTER_EXPIRY_SEC has passed (F-092-ah, ADR-0047 decision 2):
      // those holds become uses. Any the sweep already gave back are claimed
      // back, past the coupon's limit if they must be — the payer paid the
      // discounted price. Each call moves only its own status, so both run.
      // A short payment is not the discounted price paid: its holds go back
      // (F-104-d, D-32).
      if (!full) {
        await this.reservations.release(tx, payment.id, RedemptionStatus.cancelled);
      } else {
        await this.reservations.confirm(tx, payment.id);
        if (from === PaymentStatus.expired) await this.reservations.claimExpired(tx, payment.id);
      }
      await this.accrueSettlement(tx, settled);
      await this.publishConfirmed(tx, settled, verified.referenceId, source, payment.amountCredited, verified.received, verified.shownInChat);
      if (manual) await this.auditManual(tx, settled, verified.referenceId, manual);
      return true;
    });
  }

  /**
   * The gateway reversed the payment — it is returning the money to the payer
   * (F-092-ae, ADR-0046 decision 5). Closed `failed` / `reversed`, on the
   * **caller's** transaction so the reconciliation log row commits with it.
   *
   * Guarded like the credit, `pending` then `expired`: a pending row's holds go
   * back `cancelled` (nothing timed out); an expired one's already went back.
   * A `billing.payment.reversed` event is written with it, for the payer's
   * notice (F-067-m). Answers whether this call closed it.
   */
  /**
   * The gateway answered `failed` about the payment's own authority (F-092-aj,
   * ADR-0047 decision 4). Zarinpal's `failed` is final — the user checked — so
   * the payment closes `failed` / `payment_failed` and its holds go back
   * `cancelled`, on the **caller's** transaction beside the log row. No event:
   * nothing was paid, so there is nothing to tell the payer. Answers whether
   * this call closed it.
   */
  async closeFailed(tx: Prisma.TransactionClient, payment: PaymentRow): Promise<boolean> {
    const closed = (await this.closeOpen(tx, payment, 'payment_failed')) !== null;
    if (closed) this.logger.warn(`payment ${payment.id} closed: the gateway says it failed`);
    return closed;
  }

  /**
   * The one guarded close of an open payment, shared by every path that ends
   * one without money: `pending` then `expired`, to `failed` with `failureCode`,
   * clocks cleared, holds released `cancelled`. Answers the status it closed
   * from, or `null` when another path settled it first.
   */
  private async closeOpen(
    tx: Prisma.TransactionClient,
    payment: PaymentRow,
    failureCode: string,
  ): Promise<PaymentStatus | null> {
    const data = { status: PaymentStatus.failed, failureCode, expiresAt: null, nextVerifyAt: null };
    const flip = async (from: PaymentStatus) =>
      (await tx.paymentTransaction.updateMany({ where: { id: payment.id, status: from }, data })).count === 1;
    const from = (await flip(PaymentStatus.pending))
      ? PaymentStatus.pending
      : (await flip(PaymentStatus.expired))
        ? PaymentStatus.expired
        : null;
    if (from === null) return null;
    // An expired row may still hold its coupons (F-092-ah); a release moves only live holds, so both statuses run it.
    await this.reservations.release(tx, payment.id, RedemptionStatus.cancelled);
    return from;
  }

  /**
   * A person ends an open payment nobody paid (F-092-ak). `ManualConfirmService`
   * has already asked the gateway and found no money it can see; this is the
   * close and its trail — `failed` / `rejected_manually`, holds released
   * `cancelled`, and a `payment_manual_reject` audit row — in **one**
   * transaction, so a close with no trail cannot exist. No event: nothing was
   * paid. Answers whether this call closed it.
   */
  async rejectManually(payment: PaymentRow, manual: ManualConfirmation): Promise<boolean> {
    return tenantTransaction(this.prisma, async (tx) => {
      const from = await this.closeOpen(tx, payment, 'rejected_manually');
      if (from === null) return false;
      const tenant = TenantContext.current('manual rejection audit');
      await tx.adminAuditLog.create({
        data: {
          tenantId: tenant.id,
          adminId: manual.adminId,
          action: 'payment_manual_reject',
          targetEntityType: 'payment',
          targetEntityId: payment.id,
          oldValue: { status: from, verifyAttempts: payment.verifyAttempts },
          newValue: { status: PaymentStatus.failed, failureCode: 'rejected_manually', reason: manual.reason },
          adminIpAddress: manual.ip,
        },
        select: { id: true },
      });
      this.logger.warn(`payment ${payment.id} rejected by hand by ${manual.adminId}`);
      return true;
    });
  }

  async closeReversed(tx: Prisma.TransactionClient, payment: PaymentRow): Promise<boolean> {
    if ((await this.closeOpen(tx, payment, 'reversed')) === null) return false;
    const tenant = TenantContext.current('deposit reversal event');
    const ref = gatewayRefOf(payment);
    await tx.outboxEvent.create({
      data: {
        aggregate: 'billing.payment',
        aggregateId: payment.id,
        type: OutboxEventType.PAYMENT_REVERSED,
        payload: {
          tenantId: tenant.id,
          userId: payment.userId,
          paymentId: payment.id,
          // What the payer was charged and the bank is returning, in the gateway
          // currency's minor unit — a string, as every amount on the wire.
          chargedAmountMinor: payment.chargedAmountMinor.toString(),
          amountCredited: payment.amountCredited.toFixed(2),
          gateway: { source: ref.source, id: ref.gatewayId },
        },
      },
      select: { id: true },
    });
    this.logger.warn(`payment ${payment.id} closed: the gateway reversed it`);
    return true;
  }

  /**
   * The trail of a person's credit, in the transaction that made it (F-092-z).
   * Attributed to the payment's tenant — the scope bound here, which the
   * `admin_audit_log` policy requires — whoever the person works for.
   */
  private async auditManual(
    tx: Prisma.TransactionClient,
    payment: PaymentRow,
    referenceId: string,
    manual: ManualConfirmation,
  ): Promise<void> {
    const tenant = TenantContext.current('manual confirmation audit');
    await tx.adminAuditLog.create({
      data: {
        tenantId: tenant.id,
        adminId: manual.adminId,
        action: 'payment_manual_confirm',
        targetEntityType: 'payment',
        targetEntityId: payment.id,
        oldValue: { status: PaymentStatus.pending, verifyAttempts: payment.verifyAttempts },
        newValue: {
          status: PaymentStatus.success,
          gatewayReferenceId: referenceId,
          amountCredited: payment.amountCredited.toFixed(2),
          reason: manual.reason,
        },
        adminIpAddress: manual.ip,
      },
      select: { id: true },
    });
  }

  /**
   * What a granted gateway just collected for somebody else (ADR-0041 §4,
   * F-096-d).
   *
   * The money landed in the **gateway owner's** merchant account, while this
   * tenant's user was credited out of the platform's pocket — so the platform
   * owes this tenant, and that debt is written here.
   *
   * **Inside the crediting transaction**, for the reason the ledger row and the
   * outbox event are: a wallet that grew without the debt being recorded is a
   * tenant that is owed money nothing knows about, and no later sweep can
   * reconstruct it. The unique key on `paymentTransactionId` is what makes that
   * safe under the guard above — a retried callback and a reconciliation sweep
   * both reach this code, and only the call that won the flip gets here.
   *
   * **Net of the gateway's fee** (§4): the payer covered `feeApplied` and the
   * gateway kept it, so it never reaches the owner's account and is not owed on.
   * A fee larger than the credit is not a debt in the other direction — the
   * accrual floors at zero and says so, because a negative one would be the
   * platform quietly invoicing a tenant through a settlement ledger.
   */
  private async accrueSettlement(tx: Prisma.TransactionClient, payment: PaymentRow): Promise<void> {
    if (!payment.grantId) return;
    const tenant = TenantContext.current('settlement accrual');

    const net = payment.amountCredited.minus(payment.feeApplied);
    const amount = net.isNegative() ? new Prisma.Decimal(0) : net;
    if (net.isNegative()) {
      this.logger.warn(
        `payment ${payment.id}: fee ${payment.feeApplied.toFixed(2)} exceeds the credit ` +
          `${payment.amountCredited.toFixed(2)}; accruing 0 to tenant ${tenant.id}`,
      );
    }

    await tx.gatewaySettlementEntry.create({
      data: {
        grantId: payment.grantId,
        // The tenant that is **owed**: the borrower whose user was credited,
        // which is the tenant this transaction is bound to.
        tenantId: tenant.id,
        paymentTransactionId: payment.id,
        amount,
        currencyCode: payment.currencyCode,
      },
      select: { id: true },
    });
  }

  /**
   * The cross-domain announcement, in the transaction that made it true
   * (ADR-0021).
   *
   * `payload` carries its own `tenantId` because the relay reads under no scope
   * and `outbox_event` has no tenant column of its own
   * (`prisma/domains/automation.prisma`) — the domain that writes an event
   * decides what it means, and this one means "this tenant's user was
   * credited".
   *
   * Money is a decimal **string**, the same rule every billing route answers
   * under (ADR-0019): JSON has no exact decimal, and a float here would be a
   * rounding error arriving in a consumer nobody has written yet.
   */
  private async publishConfirmed(
    tx: Prisma.TransactionClient,
    payment: PaymentRow,
    referenceId: string,
    source: ConfirmationSource,
    /** What the payment was priced to credit, before any receipt changed it. */
    amountAsked: Prisma.Decimal,
    received: GatewayReceipt | undefined,
    shownInChat: boolean | undefined,
  ): Promise<void> {
    const tenant = TenantContext.current('deposit settlement event');
    const ref = gatewayRefOf(payment);
    await tx.outboxEvent.create({
      data: {
        aggregate: 'billing.payment',
        aggregateId: payment.id,
        type: OutboxEventType.PAYMENT_CONFIRMED,
        payload: {
          tenantId: tenant.id,
          userId: payment.userId,
          paymentId: payment.id,
          amountCredited: payment.amountCredited.toFixed(2),
          // Both figures (F-104-d): what was asked, and what the gateway says
          // arrived — in the gateway currency's minor unit, as strings.
          amountAsked: amountAsked.toFixed(2),
          chargedAmountMinor: payment.chargedAmountMinor.toString(),
          ...(received
            ? { amountReceivedMinor: received.amountMinor.toString(), receivedCurrency: received.currency }
            : {}),
          gateway: { source: ref.source, id: ref.gatewayId },
          gatewayReferenceId: referenceId,
          confirmationSource: source,
          channel: payment.channel,
          ...(shownInChat ? { shownInChat: true } : {}),
        },
      },
      select: { id: true },
    });
  }
}

/**
 * Which gateway a payment names. Exactly one of the two columns is set — a
 * CHECK says so (ADR-0006, ADR-0028) — so the branch is total and a row with
 * neither is a schema violation rather than a case to handle.
 *
 * A function rather than a method: both settlement and the two askers need it,
 * and the vault read that follows it happens outside every transaction.
 */
export function gatewayRefOf(payment: PaymentRow): MerchantGatewayRef {
  const tenant = TenantContext.current('deposit gateway');
  const platform = payment.gatewayId !== null;
  const source: GatewaySource = platform ? 'platform' : 'tenant';
  const gatewayId = platform ? payment.gatewayId : payment.tenantGatewayConfigId;
  const providerName = platform ? payment.gateway?.providerName : payment.tenantGatewayConfig?.providerName;
  if (!gatewayId || !providerName) {
    throw new Error(
      `payment ${payment.id} names no gateway; the CHECK in 20260911000000_payment_legacy_port should forbid it`,
    );
  }
  // `tenantId` stays the tenant in scope: for an owned gateway that is whose
  // vault holds it, and for a granted one `GrantedVaultAccess` re-derives the
  // owner from the grant rather than trusting this field.
  return { tenantId: tenant.id, source, gatewayId, providerName, grantId: payment.grantId };
}
