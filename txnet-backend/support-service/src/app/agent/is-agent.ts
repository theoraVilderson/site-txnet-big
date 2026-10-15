import { Prisma } from '@prisma/client';

import { SUPPORT_AGENT_PERMISSION } from './support-agent.guard';

/**
 * An active account of this tenant holding `support.agent` (or `*`) from any
 * source — its role, a live membership of a group giving the key or a role
 * that holds it, or the key given to it — and not taken from it (ADR-0138's
 * one answer; F-033-s: a role-only read missed every agent in a group). The
 * tenant is matched explicitly as well as by RLS: an assignee from another
 * tenant must answer exactly as a missing one.
 */
export async function isAgent(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    WITH u_role AS (
      SELECT u."roleId" AS id FROM identity."user" u
       WHERE u.id = ${userId}::uuid
         AND u."tenantId" = ${tenantId}::uuid
         AND u."deletedAt" IS NULL
         AND u.status = 'active'::identity."UserStatus"
    ), held AS (
      SELECT p.key FROM u_role JOIN identity.role_permission rp ON rp."roleId" = u_role.id JOIN identity.permission p ON p.id = rp."permissionId"
      UNION ALL
      SELECT p.key
        FROM governance.user_group_member m
        JOIN governance.user_group_permission gp ON gp."groupId" = m."groupId"
        JOIN identity.permission p ON p.id = gp."permissionId"
       WHERE m."userId" = ${userId}::uuid AND m."memberType" = 'user' AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
      UNION ALL
      SELECT p.key
        FROM governance.user_group_member m
        JOIN governance.user_group g ON g.id = m."groupId"
        JOIN identity.role_permission rp ON rp."roleId" = g."roleId"
        JOIN identity.permission p ON p.id = rp."permissionId"
       WHERE m."userId" = ${userId}::uuid AND m."memberType" = 'user' AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
      UNION ALL
      SELECT p.key FROM identity.user_permission up JOIN identity.permission p ON p.id = up."permissionId"
       WHERE up."userId" = ${userId}::uuid AND up.effect = 'give'
    )
    SELECT 1 AS ok
      FROM u_role
     WHERE EXISTS (SELECT 1 FROM held WHERE key IN (${SUPPORT_AGENT_PERMISSION}, '*'))
       AND NOT EXISTS (
         SELECT 1 FROM identity.user_permission up JOIN identity.permission p ON p.id = up."permissionId"
          WHERE up."userId" = ${userId}::uuid AND up.effect = 'take' AND p.key = ${SUPPORT_AGENT_PERMISSION})
     LIMIT 1`;
  return rows.length > 0;
}
