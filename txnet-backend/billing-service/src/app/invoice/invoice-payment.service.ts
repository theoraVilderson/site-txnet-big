import { Injectable } from '@nestjs/common';
import { Grant, GrantSource, InvoiceStatus, Prisma, WalletReasonType } from '@prisma/client';
import { OutboxEventType, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { GRANT_AGGREGATE } from '../entitlement/delivered';
import { GrantService } from '../entitlement/grant';
import { PrismaService } from '../prisma/prisma.service';
import { CouponReservationService } from '../payment/coupon/coupon-reservation';
import { InsufficientFunds, WalletLedgerService } from '../wallet/wallet-ledger.service';
import { InvoiceShortfall, invoiceShortfall } from './invoice-shortfall';

/**
 * Paying an invoice from the wallet (F-111-b, spec §5.8 step 2).
 *
 * **One transaction**, in this order:
 *
 *  1. the invoice row, `FOR UPDATE` — the spec's "advisory lock on the
 *     invoice". A row lock rather than `pg_advisory_xact_lock` because the
 *     expiry sweep's guarded flip waits on the same lock: whichever commits
 *     first, the other re-reads `status` and finds it no longer `pending`;
 *  2. the user's wallet row, `FOR UPDATE`, so the ledger's version guard below
 *     never loses to a writer that read the balance before this one;
 *  3. sufficiency — `total <= cachedBalance - heldAmount` (F-118-a), or {@link InvoiceUnpayable}
 *     `insufficient_balance` carrying the shortfall, rounded up to the cent
 *     so a top-up of exactly `missing` covers it (F-111-c, `invoice-shortfall.ts`);
 *  4. one `product_purchase` debit of `total`, `referenceId` = the invoice.
 *     A free or fully discounted invoice moves no money and writes no row
 *     (billing invariant 2: a ledger amount is > 0);
 *  5. the invoice → `paid`;
 *  6. the Grant, `source: purchase` keyed on the invoice id — `pending` until
 *     delivery (F-111-d) activates it;
 *  7. the invoice's coupon holds → uses;
 *  8. `entitlement.grant.created` in the outbox (ADR-0021).
 *
 * Concurrent pays of one invoice queue on step 1, and every one after the
 * first finds it `paid`: the money moves exactly once (`invoice-payment.int.spec.ts`).
 * The Grant's `(source, sourceReferenceId)` unique index is the second line.
 */

export type InvoicePayRequest = {
  /** From `X-User-Id`. Another user's invoice is not found. */
  userId: string;
  invoiceId: string;
};

export type InvoicePaid = {
  id: string;
  status: InvoiceStatus;
  total: string;
  /** What `total` and `balanceAfter` are in: the invoice's (ADR-0098 part 3, F-116-h2). */
  currencyCode: string;
  /** The wallet after the debit; unchanged by a free invoice. */
  balanceAfter: string;
  /** Null for a free invoice: no ledger row. */
  walletTransactionId: string | null;
  /** No token: the link is My services' to answer, as often as asked (F-114-e-c, ADR-0085). */
  grants: Array<{ id: string; status: Grant['status'] }>;
};

export type InvoicePayRejection = 'not_found' | 'already_paid' | 'expired' | 'cancelled' | 'insufficient_balance';

export class InvoiceUnpayable extends Error {
  constructor(
    readonly reason: InvoicePayRejection,
    readonly invoiceId: string,
    /** Only for `insufficient_balance`: what is missing, and what the wallet holds — in the invoice's currency (F-116-h2). */
    readonly shortfall?: InvoiceShortfall & { currencyCode: string },
  ) {
    super(`invoice ${invoiceId} cannot be paid: ${reason}`);
    this.name = 'InvoiceUnpayable';
  }
}

type LockedInvoice = {
  id: string;
  userId: string;
  variantId: string;
  total: Prisma.Decimal;
  currencyCode: string;
  status: InvoiceStatus;
  expiresAt: Date;
};

const ZERO = new Prisma.Decimal(0);

@Injectable()
export class InvoicePaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: WalletLedgerService,
    private readonly grants: GrantService,
    private readonly reservations: CouponReservationService,
  ) {}

  pay(request: InvoicePayRequest): Promise<InvoicePaid> {
    const tenant = TenantContext.current('invoice pay');
    const { userId, invoiceId } = request;

    return tenantTransaction(this.prisma, async (tx) => {
      // RLS scopes the row to this tenant; the `userId` makes another user's
      // invoice as absent as another tenant's.
      const [invoice] = await tx.$queryRaw<LockedInvoice[]>`
        SELECT id, "userId", "variantId", total, "currencyCode", status, "expiresAt"
          FROM billing.invoice
         WHERE id = ${invoiceId}::uuid AND "userId" = ${userId}::uuid
         FOR UPDATE`;
      if (!invoice) throw new InvoiceUnpayable('not_found', invoiceId);
      // A refunded invoice was paid once (F-111-d); its clock may still be running.
      if (invoice.status === InvoiceStatus.paid || invoice.status === InvoiceStatus.refunded) {
        throw new InvoiceUnpayable('already_paid', invoiceId);
      }
      if (invoice.status === InvoiceStatus.cancelled) throw new InvoiceUnpayable('cancelled', invoiceId);
      // Past its clock but not yet swept is expired all the same: the sweep
      // would release its holds a moment later, under a paid invoice.
      const now = new Date();
      if (invoice.status === InvoiceStatus.expired || invoice.expiresAt <= now) {
        throw new InvoiceUnpayable('expired', invoiceId);
      }

      const total = new Prisma.Decimal(invoice.total);
      const [wallet] = await tx.$queryRaw<Array<{ cachedBalance: Prisma.Decimal; heldAmount: Prisma.Decimal }>>`
        SELECT "cachedBalance", "heldAmount" FROM billing.wallet WHERE "ownerUserId" = ${userId}::uuid FOR UPDATE`;
      const balance = wallet ? new Prisma.Decimal(wallet.cachedBalance) : ZERO;
      // Held money is not spendable (F-118-a): the shortfall is against what is free.
      const free = wallet ? balance.minus(new Prisma.Decimal(wallet.heldAmount)) : ZERO;
      if (free.lt(total)) {
        throw new InvoiceUnpayable('insufficient_balance', invoiceId, { ...invoiceShortfall(total, free), currencyCode: invoice.currencyCode });
      }

      let walletTransactionId: string | null = null;
      let balanceAfter = balance;
      if (total.gt(0)) {
        try {
          const movement = await this.ledger.debit(tx, {
            userId,
            amount: total,
            currencyCode: invoice.currencyCode,
            reasonType: WalletReasonType.product_purchase,
            referenceId: invoice.id,
          });
          walletTransactionId = movement.id;
          balanceAfter = movement.balanceAfter;
        } catch (e) {
          // Unreachable under the wallet lock; kept so a change to the lock fails as a refusal, not a 500.
          if (e instanceof InsufficientFunds) {
            throw new InvoiceUnpayable('insufficient_balance', invoiceId, { ...invoiceShortfall(total, free), currencyCode: invoice.currencyCode });
          }
          throw e;
        }
      }

      await tx.invoice.update({ where: { id: invoice.id }, data: { status: InvoiceStatus.paid } });

      const issued = await this.grants.issue(tx, {
        userId,
        variantId: invoice.variantId,
        source: GrantSource.purchase,
        sourceReferenceId: invoice.id,
        startsAt: now,
      });
      // The invoice lock makes a second issue for it impossible; a Grant found here was not ours.
      if (!issued.token) throw new Error(`invoice ${invoice.id} already had a Grant`);

      await this.reservations.confirm(tx, invoice.id);

      await tx.outboxEvent.create({
        data: {
          aggregate: GRANT_AGGREGATE,
          aggregateId: issued.grant.id,
          type: OutboxEventType.GRANT_CREATED,
          payload: {
            tenantId: tenant.id,
            userId,
            grantId: issued.grant.id,
            variantId: invoice.variantId,
            status: issued.grant.status,
            source: GrantSource.purchase,
            invoiceId: invoice.id,
            total: total.toFixed(2),
          },
        },
        select: { id: true },
      });

      return {
        id: invoice.id,
        status: InvoiceStatus.paid,
        total: total.toFixed(2),
        currencyCode: invoice.currencyCode,
        balanceAfter: balanceAfter.toFixed(2),
        walletTransactionId,
        grants: [{ id: issued.grant.id, status: issued.grant.status }],
      };
    });
  }
}
