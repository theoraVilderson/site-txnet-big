import { PanelReviewState, Prisma } from '@prisma/client';

import { ConfigMoveSelection } from './config-move-job.schema';

/**
 * A panel a reseller's admin may move a config to (F-311-v1): shared or the
 * reseller's own, not retired, accepted by review — the list `move-targets`
 * answers and the target a move job is refused without (F-311-ad).
 */
export const moveTargetWhere = (tenantId: string) =>
  ({ retiredAt: null, reviewState: { in: [PanelReviewState.accepted, PanelReviewState.accepted_low_trust] }, OR: [{ tenantId: null }, { tenantId }] }) satisfies Prisma.PanelWhereInput;

/** A panel a config may move to (F-311-v1); `own` is the reseller's dedicated one, else shared. */
export interface MoveTarget {
  id: string;
  name: string;
  region: string;
  own: boolean;
}

/**
 * The move targets themselves, region then name — one config's move (F-311-v1)
 * and a move job's picker (F-311-ae) read the same list. **`network.panel` has
 * no RLS**, so the tenant is written into the filter; no address and no
 * credential is selected.
 */
export async function moveTargetsOf(tx: Prisma.TransactionClient, tenantId: string): Promise<MoveTarget[]> {
  const panels = await tx.panel.findMany({
    where: moveTargetWhere(tenantId),
    select: { id: true, name: true, region: true, tenantId: true },
    orderBy: [{ region: 'asc' }, { name: 'asc' }],
  });
  return panels.map((p) => ({ id: p.id, name: p.name, region: p.region, own: p.tenantId !== null }));
}

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
  // A row already left by a move waits on its replacement, which is the one to move (ADR-0160 decision 11).
  return Prisma.sql`c."tenantId" = ${tenantId}::uuid
    AND c."status" <> 'retired' AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL AND c."supersededById" IS NULL
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
