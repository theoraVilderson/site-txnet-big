import type { Prisma } from '@prisma/client';
import { ALL_PERMISSIONS } from './permissions';

/** A role that grants `key` as a row — the same filter under a user or a group. */
const grantedBy = (key: string) => ({ rolePermissions: { some: { permission: { key } } } });
const roleGrants = (key: string): Prisma.UserWhereInput => ({ role: grantedBy(key) });

/**
 * A group membership that still counts: no end, or an end after `now`
 * (ADR-0139 (3)). Every read that asks "is this person a member" adds it, so
 * an ended membership gives nothing before the sweep removes it (GR-1-c).
 */
export function liveMembership(now: Date = new Date()): Prisma.UserGroupMemberWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/**
 * The people of `tenantId` who hold `key` (ADR-0138), ordered by id — for a
 * query that picks people by a key rather than checking one caller's token
 * (that is `holdsPermission`). Every such query asks this; `conventions.py`
 * (C-15) fails on one that reads role rows alone.
 *
 * The rule is identity's `accessOf` for a single key: a role holding `*` —
 * never narrowed — or the key from the role, a key given to the person, or a
 * group of **this** tenant that gives it through its role or its own keys;
 * and in all three cases not taken from them, since a removal wins.
 * `where` adds the caller's own conditions (active, not deleted, ...).
 *
 * Two reads: group membership has no relation from `user`, so the members of
 * groups that give the key are found first.
 */
export async function findKeyHolders(
  tx: Prisma.TransactionClient,
  tenantId: string,
  key: string,
  where: Prisma.UserWhereInput = {},
  now: Date = new Date(),
): Promise<string[]> {
  const members = await tx.userGroupMember.findMany({
    where: {
      ...liveMembership(now),
      tenantId,
      memberType: 'user',
      group: {
        allTenants: false,
        OR: [{ role: grantedBy(key) }, { permissions: { some: { permission: { key } } } }],
      },
    },
    select: { userId: true },
  });
  const viaGroup = members.flatMap((m) => (m.userId ? [m.userId] : []));
  const users = await tx.user.findMany({
    where: {
      // Nested, so a caller's own `OR` is not overwritten by this one.
      AND: [where],
      tenantId,
      OR: [
        roleGrants(ALL_PERMISSIONS),
        {
          AND: [
            {
              OR: [
                roleGrants(key),
                { permissionOverrides: { some: { effect: 'give', permission: { key } } } },
                { id: { in: viaGroup } },
              ],
            },
            { NOT: { permissionOverrides: { some: { effect: 'take', permission: { key } } } } },
          ],
        },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return users.map((u) => u.id);
}
