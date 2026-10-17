import { Prisma } from '@prisma/client';

/** What a group move names (F-027-et): the Grants ticked, or every Grant of one group. */
export type GrantGroupMoveSource = { grantIds: string[] } | { fromGroupId: string };

/** The confirm's figures: Grants that move, and their live configs that keep their link or get a new one. */
export type GrantGroupMoveCount = { grants: number; keep: number; move: number };

/**
 * The Grants a group move selects: serving (`pending`/`active`), with a group,
 * not already in the target, in the scope's tenant — every tenant's for the
 * platform owner (`tenantId` null), on the cross-tenant pool.
 */
function selectionWhere(scopeTenantId: string | null, source: GrantGroupMoveSource, toGroupId: string): Prisma.Sql {
  const named = 'grantIds' in source ? Prisma.sql`g."id" = ANY(${source.grantIds}::uuid[])` : Prisma.sql`g."panelGroupId" = ${source.fromGroupId}::uuid`;
  const tenant = scopeTenantId === null ? Prisma.empty : Prisma.sql`AND g."tenantId" = ${scopeTenantId}::uuid`;
  return Prisma.sql`g."status" IN ('pending', 'active') AND g."panelGroupId" IS NOT NULL AND g."panelGroupId" <> ${toGroupId}::uuid ${tenant} AND ${named}`;
}

/**
 * Whether config `c` keeps its link in the target group — the SQL of
 * `splitForTarget`: a target member on its panel, not draining, selling its
 * inbound (listed to it, or every group's while picked and placeable) and not
 * releasing it. A row with no inbound (placed before picks) holds the panel.
 */
function keptSql(toGroupId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "network"."panel_group_member" m
     WHERE m."groupId" = ${toGroupId}::uuid AND m."panelId" = c."panelId" AND m."role" <> 'drain'
       AND (c."inboundRemoteId" IS NULL OR EXISTS (
         SELECT 1 FROM "network"."panel_inbound" i
          WHERE i."panelId" = c."panelId" AND i."remoteId" = c."inboundRemoteId"
            AND i."enabled" AND i."goneAt" IS NULL AND i."protocol" IS NOT NULL
            AND ((i."sold" AND i."audience" = 'every_group')
                 OR EXISTS (SELECT 1 FROM "network"."panel_group_member_inbound" a
                             WHERE a."groupId" = m."groupId" AND a."panelId" = m."panelId" AND a."inboundRemoteId" = i."remoteId"))
            AND NOT EXISTS (SELECT 1 FROM "network"."inbound_release" r
                             WHERE r."groupId" = m."groupId" AND r."panelId" = m."panelId" AND r."inboundRemoteId" = i."remoteId"))))`;
}

/**
 * What the confirm shows before a group move (F-027-et, F-027-ev): how many
 * Grants, and of their live configs how many keep their link and how many get
 * a new one. A preview — a seat taken meanwhile is that Grant's refusal.
 */
export async function countRegroupSelection(tx: Prisma.TransactionClient, scopeTenantId: string | null, source: GrantGroupMoveSource, toGroupId: string): Promise<GrantGroupMoveCount> {
  const kept = keptSql(toGroupId);
  const [row] = await tx.$queryRaw<GrantGroupMoveCount[]>`
    SELECT count(DISTINCT g."id")::int AS grants,
           count(c."id") FILTER (WHERE ${kept})::int AS keep,
           count(c."id") FILTER (WHERE c."id" IS NOT NULL AND NOT ${kept})::int AS move
      FROM "entitlement"."grant" g
      LEFT JOIN "network"."config" c ON c."grantId" = g."id"
           AND c."status" <> 'retired' AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
     WHERE ${selectionWhere(scopeTenantId, source, toGroupId)}`;
  return row ?? { grants: 0, keep: 0, move: 0 };
}

/**
 * The selection frozen as a `to_group` job's items, at most `limit`: one per
 * Grant (`configId` holds its id), each carrying the Grant's tenant so the
 * drain moves it there. Answers how many were written.
 */
export function insertRegroupSelection(tx: Prisma.TransactionClient, jobId: string, scopeTenantId: string | null, source: GrantGroupMoveSource, toGroupId: string, limit: number): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO "network"."config_move_job_item" ("jobId", "tenantId", "configId")
    SELECT ${jobId}::uuid, g."tenantId", g."id"
      FROM "entitlement"."grant" g
     WHERE ${selectionWhere(scopeTenantId, source, toGroupId)}
     ORDER BY g."id"
     LIMIT ${limit}`;
}
