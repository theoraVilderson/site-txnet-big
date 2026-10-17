import { GrantBulkJob, Prisma } from '@prisma/client';
import { isPlatformTenant, OutboxEventType, platformTenantIdOf } from '@txnet-backend/shared-core';

/**
 * A bulk-by-filter job acted on a batch, ended or was cancelled (RT-1-d), in
 * the transaction that wrote it. Its page is open in three places: the job
 * tenant's own staff (`/users`, `/reseller/users`, on its `tenant:`), the
 * reseller's owner — a platform user, on its domain too (`user:`) — and the
 * platform's staff on `/my-resellers/:id` (the platform's `tenant:`). One row
 * names one tenant, so a reseller's job writes two; the owner hears both, and
 * `useLiveReread` makes that one read. A tenant with no owner (the platform
 * itself) names the admin who started the job instead.
 */
export async function announceBulkProgress(tx: Prisma.TransactionClient, job: Pick<GrantBulkJob, 'id' | 'tenantId' | 'actorUserId'>): Promise<void> {
  const tenant = await tx.tenant.findUnique({ where: { id: job.tenantId }, select: { tenantType: true, ownerUserId: true } });
  const userId = tenant?.ownerUserId ?? job.actorUserId;
  const tenants = isPlatformTenant(tenant?.tenantType) ? [job.tenantId] : [job.tenantId, await platformTenantIdOf(tx)];
  for (const tenantId of tenants) {
    await tx.outboxEvent.create({
      data: {
        aggregate: 'billing.grant_bulk_job',
        aggregateId: job.id,
        type: OutboxEventType.GRANT_BULK_PROGRESSED,
        payload: { tenantId, userId, resellerId: job.tenantId, jobId: job.id },
      },
    });
  }
}
