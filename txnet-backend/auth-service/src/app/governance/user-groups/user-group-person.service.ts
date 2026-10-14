import { Injectable } from '@nestjs/common';
import { UserGroupMemberType } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { PersonGroupView, personGroupsOf } from './user-group';
import { WITH_ACCESS, keysGiven } from './user-group-admin.service';

/**
 * One person's groups, for their page (GR-1-u, ADR-0139 (1)): the read that
 * replaces the role picker. Writes go through the members routes, which keep
 * every rule (`key_not_held`, authority, `staff_members_max`); this only says
 * what the page may offer.
 *
 * In the caller's `tenantTransaction`, so RLS keeps both reads to the scope's
 * own groups — the ambient tenant, or a reseller's when its door admitted the
 * caller on its path.
 */
@Injectable()
export class UserGroupPersonService {
  constructor(private readonly prisma: PrismaService) {}

  of(actor: { permissions: readonly string[] }, userId: string): Promise<PersonGroupView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const [groups, memberships] = await Promise.all([
        tx.userGroup.findMany({ include: WITH_ACCESS }),
        tx.userGroupMember.findMany({ where: { userId, memberType: UserGroupMemberType.user }, select: { groupId: true, expiresAt: true } }),
      ]);
      const weighed = groups.map((g) => ({ id: g.id, name: g.name, allTenants: g.allTenants, keys: keysGiven(g) }));
      return personGroupsOf(weighed, memberships, actor.permissions);
    });
  }
}
