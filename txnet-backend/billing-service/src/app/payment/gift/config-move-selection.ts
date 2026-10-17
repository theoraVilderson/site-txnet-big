import { PanelReviewState, Prisma } from '@prisma/client';

import { ConfigMoveSelection } from './config-move-job.schema';

/**
 * A panel a reseller's admin may move a config to (F-311-v1): shared or the
 * reseller's own, not retired, accepted by review — the list `move-targets`
 * answers and the target a move job is refused without (F-311-ad).
 */
export const moveTargetWhere = (tenantId: string) =>
  ({ retiredAt: null, reviewState: { in: [PanelReviewState.accepted, PanelReviewState.accepted_low_trust] }, OR: [{ tenantId: null }, { tenantId }] }) satisfies Prisma.PanelWhereInput;

/**
 * The configs a move job takes (F-311-ad), as one `WHERE`: the reseller's own
 * — the tenant is in the query (C-15), `network.config` is read under its
 * RLS too — live (`present`, not retired, not drained), not already on the
 * target, and on the source panel or of a user named.
 */
function selectionWhere(tenantId: string, s: ConfigMoveSelection): Prisma.Sql {
  // The schema allows exactly one of the two; read both, so either shape types.
  const { panelId, userIds = [] } = s.source as { panelId?: string; userIds?: string[] };
  const source = panelId ? Prisma.sql`c."panelId" = ${panelId}::uuid` : Prisma.sql`c."userId" = ANY(${userIds}::uuid[])`;
  return Prisma.sql`c."tenantId" = ${tenantId}::uuid
    AND c."status" <> 'retired' AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
    AND c."panelId" <> ${s.toPanelId}::uuid
    AND ${source}`;
}

/** How many configs the selection takes now — what the confirm shows. */
export async function countMoveSelection(tx: Prisma.TransactionClient, tenantId: string, s: ConfigMoveSelection): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "network"."config" c WHERE ${selectionWhere(tenantId, s)}`;
  return Number(row?.n ?? 0);
}

/** Writes at most `limit` of the selection as the job's items, in one `INSERT … SELECT`, and answers how many. */
export function insertMoveSelection(tx: Prisma.TransactionClient, jobId: string, tenantId: string, s: ConfigMoveSelection, limit: number): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO "network"."config_move_job_item" ("jobId", "tenantId", "configId")
    SELECT ${jobId}::uuid, c."tenantId", c."id" FROM "network"."config" c
     WHERE ${selectionWhere(tenantId, s)}
     ORDER BY c."id"
     LIMIT ${limit}`;
}
