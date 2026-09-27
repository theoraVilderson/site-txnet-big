import { GrantSource, GrantStatus, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { PANEL_MY_SERVICES_PATH, panelUrlOf } from '../request/panel-url';
import { unusedClockOf } from './unused-clock';

/** `aggregate` of every Grant event in the outbox (ADR-0021). */
export const GRANT_AGGREGATE = 'entitlement.grant';

/**
 * A `pending` Grant is delivered: `active`, and `entitlement.grant.delivered`
 * in the outbox beside it (F-111-d, spec §5.8 step 3), so the user is told and
 * an open panel turns it live. "Ready" says where (F-601-h): `servicesUrl`,
 * the tenant's own My services page, when it has a host to send a user to.
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
  // Delivery is activation: the "not connected yet?" clock starts here
  // (F-601-c). Only a purchase is ever `pending`.
  const activatedAt = new Date();
  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.pending },
    data: { status: GrantStatus.active, nextDeliveryAt: null, activatedAt, unusedCheckAt: unusedClockOf(GrantSource.purchase, activatedAt) },
  });
  if (moved.count !== 1) return false;

  const grant = await tx.grant.findUnique({
    where: { id: grantId },
    select: { tenantId: true, userId: true, variantId: true, source: true, sourceReferenceId: true },
  });
  if (!grant) throw new Error(`grant ${grantId} vanished inside its own delivery`);
  const servicesUrl = await panelUrlOf(tx, grant.tenantId, PANEL_MY_SERVICES_PATH);

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
        ...(servicesUrl ? { servicesUrl } : {}),
      },
    },
    select: { id: true },
  });
  return true;
}
