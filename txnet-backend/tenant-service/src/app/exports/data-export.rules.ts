import type { Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

/**
 * The numbers of a tenant's data export (F-212-a, catalog §14.8), in one place
 * for the request and the drain. `contract.data-export.md` states each.
 */

const HOUR_MS = 3_600_000;

/** §14.8: an export at most once per 24 h — a failed one does not count. */
export const EXPORT_EVERY_MS = 24 * HOUR_MS;
/** How long a built archive stays before the drain deletes it; the URL is minted per download. */
export const ARCHIVE_KEEP_MS = 7 * 24 * HOUR_MS;
/** §14.8's "short-lived signed URL": the same five minutes as every private file (ADR-0113). */
export const LINK_TTL_SEC = 5 * 60;
/** One build may take this long inside its snapshot before the transaction is abandoned. */
export const BUILD_TIMEOUT_MS = 10 * 60_000;
/** A build's lease: longer than its transaction and the store after it, so a live one is never taken twice. */
export const BUILD_LEASE_MS = 20 * 60_000;
/** A build whose lease ran out this many times is failed, not retried again. */
export const BUILD_MAX_ATTEMPTS = 3;

/** The archive's logical path on the storage port; the tenant is the key's prefix. */
export const exportPath = (exportId: string) => `exports/${exportId}.jsonl.gz`;

/**
 * `tenant.data_export.changed` (RT-1, C-14): the requester's open page re-reads
 * the list. Only they wait on it — the owner on the platform's panel, a staff
 * member on theirs — so it goes to their own channel. Ids only.
 */
export async function announceExport(tx: Prisma.TransactionClient, row: { id: string; tenantId: string; requestedByUserId: string }): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregate: 'tenant.data_export',
      aggregateId: row.id,
      type: OutboxEventType.TENANT_DATA_EXPORT_CHANGED,
      payload: { userId: row.requestedByUserId, resellerId: row.tenantId, exportId: row.id },
    },
    select: { id: true },
  });
}
