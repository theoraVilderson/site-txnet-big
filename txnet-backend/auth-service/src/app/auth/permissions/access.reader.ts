import { Injectable } from '@nestjs/common';
import { TenantType, type Prisma } from '@prisma/client';
import { isPlatformKey, liveMembership } from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { accessOf, type AccessSources, type UserAccess } from './access';

/** The role keys `TokenService` mints from, as every caller loads them. */
type LoadedUser = { id: string; role?: { rolePermissions?: { permission: { key: string } }[] } | null };

const ROLE_KEYS = { role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } } } as const;

/** A group that gives a person access, named — `accessOf` reads only its keys. */
type GroupSource = { id: string; name: string; roleKeys: string[]; keys: string[] };

/** Sources beyond the role, per person; empty for anyone nothing else applies to. */
type Personal = Omit<AccessSources, 'roleKeys' | 'groups'> & { groups: GroupSource[]; platformTenant: boolean };

/** The client a read runs on: the cross-tenant pool by default, or a writer's own transaction. */
type Reader = Pick<Prisma.TransactionClient, 'userPermission' | 'userGroupMember' | 'user'>;

/**
 * A group gives access when it names a role or holds a key, and never when it
 * is "every reseller" — its members are resellers, not people (AC-1-m).
 */
const GIVES_ACCESS: Prisma.UserGroupWhereInput = { allTenants: false, OR: [{ roleId: { not: null } }, { permissions: { some: {} } }] };

/**
 * Reads what decides one person's answer (ADR-0138) and asks `accessOf`.
 *
 * Every token mint, the Redis writer and the authority rule come here, so the
 * answer is read one way. It reads on the cross-tenant pool, by person id: a
 * mint and a `LISTEN` callback have no ambient tenant that would make RLS the
 * boundary, and the ids are the server's own, never the caller's.
 */
@Injectable()
export class AccessReader {
  constructor(private readonly prisma: CrossTenantPrismaService) {}

  /**
   * The answer for a user whose role keys are already loaded (every sign-in
   * path loads them). A writer passes its own transaction as `client`, so it
   * reads the rows it is about to change, under its tenant's RLS.
   */
  async ofLoaded(user: LoadedUser, client: Reader = this.prisma): Promise<UserAccess> {
    return (await this.ofLoadedMany([user], client)).get(user.id) as UserAccess;
  }

  /**
   * {@link ofLoaded} for a page of people, in one read — what a list's `canAct` weighs.
   * `at`: the moment memberships are judged live at — now, or just before one
   * ended, for the answer the person held then (GR-1-c's sweep).
   */
  async ofLoadedMany(users: readonly LoadedUser[], client: Reader = this.prisma, at: Date = new Date()): Promise<Map<string, UserAccess>> {
    const personal = await this.personalOf(users, client, at);
    return new Map(
      users.map((u) => {
        const { platformTenant, ...sources } = personal.get(u.id) ?? { platformTenant: false };
        const access = accessOf({ roleKeys: roleKeysOf(u), ...sources });
        return [u.id, access.personal && platformTenant ? { ...access, platformTenant: true } : access];
      }),
    );
  }

  /**
   * The groups that give this person access, each with every key it gives
   * them — the group's role and its own keys. What a Permissions section
   * names as a key's source (AC-1-n); the same rule the answer counts by.
   */
  async groupsOf(userId: string, client: Reader = this.prisma): Promise<{ id: string; name: string; keys: string[] }[]> {
    const groups = (await this.personalOf([{ id: userId }], client)).get(userId)?.groups ?? [];
    return groups
      .map((g) => ({ id: g.id, name: g.name, keys: [...new Set([...g.roleKeys, ...g.keys])].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The answer for these people, read in one pass — absent ids are left out. */
  async ofIds(userIds: readonly string[]): Promise<Map<string, UserAccess>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, ...ROLE_KEYS },
    });
    return this.ofLoadedMany(users);
  }

  /**
   * Everyone something beyond their role applies to, optionally only those
   * whose answer a change to `roleId` reaches — held directly or through a
   * group. What the writer recomputes after a role edit (ADR-0138 (5)).
   */
  async personalPeople(roleId?: string): Promise<string[]> {
    const [given, members] = await Promise.all([
      this.prisma.userPermission.findMany({ where: roleId ? { user: { roleId } } : {}, select: { userId: true }, distinct: ['userId'] }),
      this.prisma.userGroupMember.findMany({
        where: { ...liveMembership(), memberType: 'user', userId: { not: null }, group: GIVES_ACCESS },
        select: { userId: true, group: { select: { roleId: true } } },
      }),
    ]);
    const people = new Set(given.map((r) => r.userId));
    if (!roleId) for (const m of members) people.add(m.userId as string);
    else {
      // Reached through the group's role, or holding the role themselves.
      for (const m of members) if (m.group.roleId === roleId) people.add(m.userId as string);
      const rest = members.map((m) => m.userId as string).filter((id) => !people.has(id));
      if (rest.length > 0) {
        for (const u of await this.prisma.user.findMany({ where: { id: { in: rest }, roleId }, select: { id: true } })) people.add(u.id);
      }
    }
    return [...people];
  }

  /** Each of a group's user members — what the writer recomputes when the group's access moves. */
  async membersOf(groupId: string): Promise<string[]> {
    const rows = await this.prisma.userGroupMember.findMany({ where: { groupId, memberType: 'user' }, select: { userId: true } });
    return rows.flatMap((r) => (r.userId ? [r.userId] : []));
  }

  /**
   * What applies to each person beyond their role: the keys given to and
   * taken from them (AC-1-l), and every group of **their own tenant** that
   * gives access (AC-1-m), while the membership lasts (ADR-0139 (3)). A platform group may hold another tenant's user;
   * the platform's keys are not theirs, so that membership counts for nothing. A group's `platform.` key counts only
   * for someone of the platform owner's tenant (ADR-0139 (4)): the writer refuses it elsewhere, and this drops it
   * elsewhere, so a row written past the writer still reaches no reseller's token.
   */
  private async personalOf(users: readonly Pick<LoadedUser, 'id'>[], client: Reader, at: Date = new Date()): Promise<Map<string, Personal>> {
    type Entry = Personal & { given: string[]; taken: string[] };
    const out = new Map<string, Entry>();
    if (users.length === 0) return out;
    const ids = users.map((u) => u.id);
    const [rows, memberships, tenants] = await Promise.all([
      client.userPermission.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, effect: true, permission: { select: { key: true } } },
      }),
      client.userGroupMember.findMany({
        where: { ...liveMembership(at), userId: { in: ids }, memberType: 'user', group: GIVES_ACCESS },
        select: {
          userId: true,
          tenantId: true,
          group: { select: { id: true, name: true, role: ROLE_KEYS.role, permissions: { select: { permission: { select: { key: true } } } } } },
        },
      }),
      client.user.findMany({ where: { id: { in: ids } }, select: { id: true, tenantId: true, tenant: { select: { tenantType: true } } } }),
    ]);
    const platformHome = new Set(tenants.filter((u) => u.tenant?.tenantType === TenantType.platform_owner).map((u) => u.id));
    const entry = (id: string) =>
      out.get(id) ?? (out.set(id, { given: [], taken: [], groups: [], platformTenant: platformHome.has(id) }).get(id) as Entry);
    for (const row of rows) (row.effect === 'take' ? entry(row.userId).taken : entry(row.userId).given).push(row.permission.key);
    const tenantOf = new Map(tenants.map((u) => [u.id, u.tenantId]));
    for (const m of memberships) {
      if (!m.userId || tenantOf.get(m.userId) !== m.tenantId) continue;
      const counts = (k: string) => platformHome.has(m.userId as string) || !isPlatformKey(k);
      entry(m.userId).groups.push({
        id: m.group.id,
        name: m.group.name,
        roleKeys: (m.group.role?.rolePermissions.map((rp) => rp.permission.key) ?? []).filter(counts),
        keys: m.group.permissions.map((p) => p.permission.key).filter(counts),
      });
    }
    return out;
  }
}

function roleKeysOf(user: LoadedUser): string[] {
  return user.role?.rolePermissions?.map((rp) => rp.permission.key) ?? [];
}
