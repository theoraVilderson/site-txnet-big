import { DesiredRemote, Prisma } from '@prisma/client';

import { GrantBulkFilter } from './grant-bulk-job.schema';

/**
 * Which of a reseller's Grants a bulk filter names (F-311-u2) — the one
 * `WHERE` the count and the job's frozen selection share, so the number the
 * confirm showed and the Grants the job holds are the same query.
 *
 * **The fence is the Grant's `tenantId`** (C-15), in the query as well as in
 * RLS, for the reason `reseller-grants-bulk.ts` gives. A panel is a live
 * config on it (`desiredRemote = present`): a Grant already moved off the
 * panel that was down is not that panel's.
 */
function selectionWhere(tenantId: string, f: GrantBulkFilter): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`g."tenantId" = ${tenantId}::uuid`,
    Prisma.sql`g."status"::text IN (${Prisma.join(f.statuses)})`,
  ];
  if (f.variantId) conditions.push(Prisma.sql`g."variantId" = ${f.variantId}::uuid`);
  if (f.productId) {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "catalog"."product_variant" v WHERE v."id" = g."variantId" AND v."productId" = ${f.productId}::uuid)`);
  }
  if (f.panelId) {
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "network"."config" c WHERE c."grantId" = g."id" AND c."panelId" = ${f.panelId}::uuid AND c."desiredRemote" = ${DesiredRemote.present}::"network"."DesiredRemote")`,
    );
  }
  return Prisma.join(conditions, ' AND ');
}

/** How many Grants the filter matches now: what the confirm shows. */
export async function countSelection(tx: Prisma.TransactionClient, tenantId: string, filter: GrantBulkFilter): Promise<number> {
  const [{ n }] = await tx.$queryRaw<[{ n: number }]>`SELECT COUNT(*)::int AS n FROM "entitlement"."grant" g WHERE ${selectionWhere(tenantId, filter)}`;
  return n;
}

/**
 * The job's items: the matching Grants now, in one statement, at most `limit`
 * — the selection frozen at the confirm. Answers how many were written.
 */
export function insertSelection(tx: Prisma.TransactionClient, jobId: string, tenantId: string, filter: GrantBulkFilter, limit: number): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO "billing"."grant_bulk_job_item" ("jobId", "tenantId", "grantId")
    SELECT ${jobId}::uuid, g."tenantId", g."id"
      FROM "entitlement"."grant" g
     WHERE ${selectionWhere(tenantId, filter)}
     ORDER BY g."id"
     LIMIT ${limit}`;
}
