import { GrantSource, GrantStatus, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

/** `aggregate` of every Grant event in the outbox (ADR-0021). */
export const GRANT_AGGREGATE = 'entitlement.grant';

/**
 * A `pending` Grant is delivered: `active`, and `entitlement.grant.delivered`
 * in the outbox beside it (F-111-d, spec §5.8 step 3), so the user is told and
 * an open panel turns it live.
 *
 * A function rather than a `GrantService` method, as `suspendForExhaustion`
 * is: every handler that delivers calls it — group fulfilment when the panels
 * confirm (network `contract.groups.md` rule 10), the delivery sweep for a
 * kind with nothing to wait for — and neither should import a module for it.
 *
 * Conditional on `pending`, so a cancel meanwhile stands and a second caller
 * writes nothing: `false` means this call did not deliver it.
 */
export async function markDelivered(tx: Prisma.TransactionClient, grantId: string): Promise<boolean> {
  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.pending },
    data: { status: GrantStatus.active, nextDeliveryAt: null },
  });
  if (moved.count !== 1) return false;

  const grant = await tx.grant.findUnique({
    where: { id: grantId },
    select: { tenantId: true, userId: true, variantId: true, source: true, sourceReferenceId: true },
  });
  if (!grant) throw new Error(`grant ${grantId} vanished inside its own delivery`);

  await tx.outboxEvent.create({
    data: {
      aggregate: GRANT_AGGREGATE,
      aggregateId: grantId,
      type: OutboxEventType.GRANT_DELIVERED,
      payload: {
        tenantId: grant.tenantId,
        userId: grant.userId,
        grantId,
        variantId: grant.variantId,
        source: grant.source,
        invoiceId: grant.source === GrantSource.purchase ? grant.sourceReferenceId : null,
      },
    },
    select: { id: true },
  });
  return true;
}
