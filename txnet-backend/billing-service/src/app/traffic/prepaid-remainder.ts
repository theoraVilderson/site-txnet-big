import { GrantSource, GrantStatus, InvoiceStatus, Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';

import { usedBytesOf } from '../entitlement/renewal';
import type { WalletCreditService } from '../wallet/wallet-credit.service';
import { RemainderCreditRefused } from './remainder-credit';

/**
 * A deleted prepaid Grant's remainder (F-311-m, user 2026-09-28) — the prepaid
 * half of what F-027-r does for a metered bag.
 *
 * A prepaid Grant sold **both** a volume and a time, so what is left of it is
 * the smaller of the two: `total × (1 − max(volume used, time gone))`, rounded
 * **down** to a cent. The larger share decides because either one alone would
 * pay back what was used: a user who spent the whole bag on day one is owed
 * nothing, and neither is one who sat on it for 29 of 30 days. An unlimited
 * Grant is measured by time alone, a permanent one by volume alone.
 *
 * Only what was **paid**: the purchase invoice's `total` (after discounts —
 * a coupon was not money the user paid, as F-111-d's full refund says), and a
 * Grant not bought with money gives nothing back. Renewals have no caller that
 * records their price yet; when one lands, what it paid belongs in this sum.
 */

/** Whole cents out of what time says is left, what volume says is left — the smaller. */
export function sizePrepaidRemainder(input: {
  totalCents: bigint;
  startsAt: Date;
  endsAt: Date | null;
  /** When the clock stopped: the delete, or the moment a frozen Grant froze. */
  stoppedAt: Date;
  usedBytes: bigint;
  quotaBytes: bigint;
  unlimited: boolean;
}): bigint {
  const candidates: bigint[] = [];

  if (input.endsAt) {
    const span = BigInt(Math.max(1, input.endsAt.getTime() - input.startsAt.getTime()));
    const left = BigInt(Math.min(Math.max(0, input.endsAt.getTime() - input.stoppedAt.getTime()), Number(span)));
    candidates.push((input.totalCents * left) / span);
  }
  if (!input.unlimited) {
    const quota = input.quotaBytes;
    const left = quota > input.usedBytes ? quota - input.usedBytes : BigInt(0);
    candidates.push(quota > BigInt(0) ? (input.totalCents * left) / quota : BigInt(0));
  }
  if (candidates.length === 0) throw new RemainderCreditRefused('not_measurable');

  const cents = candidates.reduce((a, b) => (b < a ? b : a));
  if (cents < BigInt(1)) throw new RemainderCreditRefused('nothing_to_credit');
  return cents;
}

const CENTS = BigInt(100);

/**
 * Credits a closed prepaid Grant's remainder, in the caller's transaction, as
 * `product_refund` against its invoice — the reason F-111-d's full refund uses,
 * so the reseller's revenue nets it off the sale (`UNDOES`). The invoice stays
 * `paid`: part of it was delivered. Once only, because the one caller cancels
 * the Grant in the same transaction and `cancelled` is terminal.
 */
export async function creditPrepaidRemainder(
  tx: Prisma.TransactionClient,
  ledger: Pick<WalletCreditService, 'credit'>,
  input: { grantId: string; at: Date; stoppedAt: Date | null },
): Promise<{ amount: Prisma.Decimal; walletTransactionId: string }> {
  const grant = await tx.grant.findUnique({ where: { id: input.grantId } });
  if (!grant) throw new RemainderCreditRefused('grant_not_found', input.grantId);
  if (grant.status !== GrantStatus.cancelled && grant.status !== GrantStatus.expired && grant.status !== GrantStatus.exhausted) {
    throw new RemainderCreditRefused('grant_not_closed', `${input.grantId} is ${grant.status}`);
  }
  if (grant.billingMode !== VariantBillingMode.prepaid) throw new RemainderCreditRefused('grant_not_prepaid', input.grantId);
  if (grant.source !== GrantSource.purchase || !grant.sourceReferenceId) throw new RemainderCreditRefused('nothing_paid', grant.source);

  const invoice = await tx.invoice.findFirst({
    where: { id: grant.sourceReferenceId, status: InvoiceStatus.paid },
    select: { id: true, userId: true, total: true, currencyCode: true },
  });
  if (!invoice || !new Prisma.Decimal(invoice.total).gt(0)) throw new RemainderCreditRefused('nothing_paid', grant.sourceReferenceId);

  const totalCents = BigInt(new Prisma.Decimal(invoice.total).mul(100).toFixed(0));
  const cents = sizePrepaidRemainder({
    totalCents,
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
    stoppedAt: input.stoppedAt ?? input.at,
    usedBytes: await usedBytesOf(tx, grant.id),
    quotaBytes: grant.purchasedBytes,
    unlimited: grant.trafficUnlimited,
  });

  const amount = new Prisma.Decimal(cents.toString()).div(CENTS.toString());
  const movement = await ledger.credit(tx, { userId: invoice.userId, amount, currencyCode: invoice.currencyCode, reasonType: WalletReasonType.product_refund, referenceId: invoice.id });
  return { amount, walletTransactionId: movement.id };
}
