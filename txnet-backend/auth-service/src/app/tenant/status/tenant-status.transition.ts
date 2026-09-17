import { Prisma, TenantStatus, TenantSuspensionCause } from '@prisma/client';

/**
 * One tenant's move between statuses, inside the caller's transaction and
 * under the tenant row's lock the caller already holds (F-018-f, F-019-c). The
 * platform owner's `PUT .../status` and the subscription renewal both come
 * here, so the stamps and the history row cannot drift apart.
 *
 * Suspending stamps `suspendedAt` = now, `graceEndsAt` = now + `holdDays` and
 * why (`suspensionCause`); reactivating clears all four; terminating keeps
 * them for the record. One `tenant_status_history` row, `actorUserId` null
 * when the platform moved it. Nothing is deleted.
 */

const DAY_MS = 86_400_000;

export type TenantStatusChange = {
  from: TenantStatus;
  to: TenantStatus;
  reason: string | null;
  /** Null when the platform itself moved the tenant (a renewal). */
  actorUserId: string | null;
  /** Read only when `to` is `suspended`. */
  cause?: TenantSuspensionCause;
  holdDays?: number;
  now: Date;
};

export type TenantStatusRow = {
  id: string;
  status: TenantStatus;
  suspendedAt: Date | null;
  graceEndsAt: Date | null;
  suspendedReason: string | null;
};

export async function applyTenantStatus(tx: Prisma.TransactionClient, tenantId: string, change: TenantStatusChange): Promise<TenantStatusRow> {
  const { to, reason, now } = change;
  const data: Prisma.TenantUpdateInput =
    to === TenantStatus.suspended
      ? {
          status: to,
          suspensionCause: change.cause ?? TenantSuspensionCause.manual,
          suspendedAt: now,
          graceEndsAt: new Date(now.getTime() + (change.holdDays ?? 0) * DAY_MS),
          suspendedReason: reason,
        }
      : to === TenantStatus.active
        ? { status: to, suspensionCause: null, suspendedAt: null, graceEndsAt: null, suspendedReason: null }
        : // Terminated keeps when and why it was suspended, for the record; the policy closes /sub regardless.
          { status: to, suspendedReason: reason };
  const after = await tx.tenant.update({
    where: { id: tenantId },
    data,
    select: { id: true, status: true, suspendedAt: true, graceEndsAt: true, suspendedReason: true },
  });
  await tx.tenantStatusHistory.create({
    data: { tenantId, fromStatus: change.from, toStatus: to, reason, actorUserId: change.actorUserId },
  });
  return after;
}
