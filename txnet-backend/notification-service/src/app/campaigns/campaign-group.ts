import { Prisma, UserGroupMemberType } from '@prisma/client';
import { type AudienceGroupReader, type AudienceGroupRefusal, liveMembership, refusedAudienceGroup } from '@txnet-backend/shared-core';

import type { AudienceFilter } from './campaign-admin.schema';

/** The most members one group campaign reaches (C-28): far above a real group, a bound on a runaway one. */
export const GROUP_AUDIENCE_MAX = 100_000;

/**
 * A group campaign's people (GR-1-y): its user members whose membership was
 * live at `at` — the send's start, or now for a count. Read once per pass and
 * handed to `audienceWhere`, since a member row has no relation to its user.
 */
export async function groupMemberIds(db: Pick<Prisma.TransactionClient, 'userGroupMember'>, groupId: string, at: Date): Promise<string[]> {
  const rows = await db.userGroupMember.findMany({
    where: { groupId, memberType: UserGroupMemberType.user, ...liveMembership(at) },
    select: { userId: true },
    orderBy: { userId: 'asc' },
    take: GROUP_AUDIENCE_MAX,
  });
  return rows.flatMap((r) => (r.userId ? [r.userId] : []));
}

/**
 * ADR-0143 on a campaign's write: a group named in the audience must be the
 * campaign tenant's and one the caller may pick, unless the draft already had
 * it (`kept`). `null` when it may go ahead, or there is no group.
 */
export function campaignGroupRefusal(
  db: AudienceGroupReader,
  acting: readonly string[],
  audience: AudienceFilter,
  opts: { kept: string | null; tenantId: string },
): Promise<AudienceGroupRefusal | null> {
  if (!audience.groupId) return Promise.resolve(null);
  return refusedAudienceGroup(db, acting, [audience.groupId], { kept: opts.kept ? [opts.kept] : [], tenantId: opts.tenantId });
}
