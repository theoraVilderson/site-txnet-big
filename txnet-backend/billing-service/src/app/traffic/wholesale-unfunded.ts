import { GrantMeter, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { onPlatformPanel } from './vpn-wholesale';

/**
 * A reseller at zero (F-118-w). A block its billing wallet cannot fund the
 * wholesale leg of is refused `wholesale_unfunded` (F-118-n3), and the users
 * of its groups holding a platform panel stop at their bag. Nothing else
 * stops: the Grant stays `active` — `suspendIfExhausted` reads the user's
 * wallet only — so its own panels keep serving it.
 *
 * **Once per refusal spell.** The planner asks again (`leaseplan.WholesaleRetry`),
 * and every refusal would otherwise tell again. `tenant_billing_wallet.unfundedNoticeAt`
 * is the spell: the refusal that sets it, only while null, emits
 * `tenant.billing.wholesale_unfunded` to the reseller's owner; a block the
 * wallet funds on a platform panel clears it. A block of the reseller's own
 * panels only says nothing of the platform side, so it clears nothing.
 */

/** The outbox aggregate of a reseller's billing wallet. */
export const TENANT_BILLING_AGGREGATE = 'tenant.billing';

/** Marks the spell and tells it, in the caller's transaction; null when it was already told. */
export async function noticeWholesaleUnfunded(tx: Prisma.TransactionClient, payerTenantId: string, now = new Date()): Promise<'told' | null> {
  const marked = await tx.tenantBillingWallet.updateMany({ where: { tenantId: payerTenantId, unfundedNoticeAt: null }, data: { unfundedNoticeAt: now } });
  if (marked.count !== 1) return null;
  const tenant = await tx.tenant.findUnique({ where: { id: payerTenantId }, select: { ownerUserId: true } });
  if (!tenant) return null;
  await tx.outboxEvent.create({
    data: {
      aggregate: TENANT_BILLING_AGGREGATE,
      aggregateId: payerTenantId,
      type: OutboxEventType.TENANT_WHOLESALE_UNFUNDED,
      payload: { tenantId: payerTenantId, ownerUserId: tenant.ownerUserId, period: now.toISOString() },
    },
    select: { id: true },
  });
  return 'told';
}

/**
 * Ends the spell after a funded block, in its transaction: only on a group
 * holding a platform panel, and only the marker it read. One read when no
 * spell is open, which is every block of a reseller in funds.
 */
export async function rearmWholesaleNotice(
  tx: Prisma.TransactionClient,
  grant: { variantId: string },
  meter: Pick<GrantMeter, 'wholesalePayerTenantId'>,
): Promise<boolean> {
  const tenantId = meter.wholesalePayerTenantId;
  if (!tenantId) return false;
  const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId }, select: { unfundedNoticeAt: true } });
  if (!wallet?.unfundedNoticeAt) return false;
  if (!(await onPlatformPanel(tx, grant.variantId))) return false;
  const cleared = await tx.tenantBillingWallet.updateMany({ where: { tenantId, unfundedNoticeAt: wallet.unfundedNoticeAt }, data: { unfundedNoticeAt: null } });
  return cleared.count === 1;
}
