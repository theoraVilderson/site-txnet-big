import { randomUUID } from 'node:crypto';

import { Grant, GrantSource, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { GRANT_AGGREGATE } from '../entitlement/delivered';
import { renewGrant } from '../entitlement/renewal';
import { RenewalRefused, renewalSaleOf } from './renewal-invoice';

/**
 * The step a paid renewal invoice takes in place of issuing a Grant (F-305-d,
 * billing `contract.renewal.md` rules 11–14, ADR-0158), inside the payment's
 * transaction, after the debit and the flip to `paid`:
 *
 *  1. the Grant's row, `FOR UPDATE`, scoped to the payer — so nothing moves
 *     its bag or end between the check and the raise;
 *  2. the renewal is asked again at this instant (`renewalSaleOf`): a Grant
 *     closed or a plan switched off since the quote refuses the whole payment,
 *     as a variant switched off refuses a purchase's issue;
 *  3. `renewGrant` with the bytes and days **quoted** (rule 9), the invoice's
 *     renewal id named by an unlimited plan's wholesale charge; a reseller's
 *     package plan buys its raise wholesale there (invariant 30);
 *  4. one `grant_renewal` row, the payer its actor and the invoice its
 *     request: one invoice, one renewal (entitlement invariant 27);
 *  5. a plan switch writes the Grant's new variant, bag and period, so its
 *     next renewal is of that plan (rule 12);
 *  6. `entitlement.grant.renewed` to the payer's `user:` channel (C-14) —
 *     My services re-reads the row. No notice: the payer pressed pay, as with
 *     their own freeze (F-0401-c), so a revival is not told either.
 */

/** A paid renewal invoice, as the payment locked it. */
export type RenewalInvoice = { id: string; userId: string; variantId: string; grantId: string; renewBytes: bigint; renewDays: number };

type LockedGrant = { id: string; tenantId: string; purchasedBytes: bigint; endsAt: Date | null };

export async function renewByInvoice(tx: Prisma.TransactionClient, invoice: RenewalInvoice, at: Date): Promise<{ id: string; status: Grant['status'] }> {
  const [grant] = await tx.$queryRaw<LockedGrant[]>`
    SELECT id, "tenantId", "purchasedBytes", "endsAt"
      FROM entitlement."grant"
     WHERE id = ${invoice.grantId}::uuid AND "userId" = ${invoice.userId}::uuid
     FOR UPDATE`;
  if (!grant) throw new RenewalRefused('grant_not_found', invoice.grantId);
  const sale = await renewalSaleOf(tx, { userId: invoice.userId, grantId: grant.id, variantId: invoice.variantId, at });

  // Chosen before the row exists: an unlimited plan's wholesale charge names it (F-118-z).
  const renewalId = randomUUID();
  const done = await renewGrant(tx, {
    grantId: grant.id,
    bytes: invoice.renewBytes,
    days: invoice.renewDays,
    source: GrantSource.purchase,
    at,
    tellReactivated: false,
    referenceId: renewalId,
  });
  await tx.grantRenewal.create({
    data: {
      id: renewalId,
      tenantId: grant.tenantId,
      grantId: grant.id,
      requestId: invoice.id,
      actorUserId: invoice.userId,
      plan: true,
      bytes: invoice.renewBytes,
      days: invoice.renewDays,
      forgivenBytes: done.forgivenBytes,
      purchasedBytesBefore: grant.purchasedBytes,
      purchasedBytesAfter: done.purchasedBytes,
      endsAtBefore: grant.endsAt,
      endsAtAfter: done.endsAt,
    },
  });
  if (sale.amount.switched) {
    // The plan as it is now (ADR-0158 (1)); the group is the Grant's own and unchanged (invariant 31).
    await tx.grant.update({
      where: { id: grant.id },
      data: { variantId: sale.offer.variantId, quotas: structuredClone(sale.offer.quotas ?? {}), periodDays: sale.offer.durationDays },
    });
  }

  await tx.outboxEvent.create({
    data: {
      aggregate: GRANT_AGGREGATE,
      aggregateId: grant.id,
      type: OutboxEventType.GRANT_RENEWED,
      payload: { tenantId: grant.tenantId, userId: invoice.userId, grantId: grant.id, invoiceId: invoice.id, renewalId },
    },
    select: { id: true },
  });
  const { status } = await tx.grant.findUniqueOrThrow({ where: { id: grant.id }, select: { status: true } });
  return { id: grant.id, status };
}
