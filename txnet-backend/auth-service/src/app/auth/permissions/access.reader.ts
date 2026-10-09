import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { accessOf, type AccessSources, type UserAccess } from './access';

/** The role keys `TokenService` mints from, as every caller loads them. */
type LoadedUser = { id: string; role?: { rolePermissions?: { permission: { key: string } }[] } | null };

const ROLE_KEYS = { role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } } } as const;

/** Sources beyond the role, per person; empty for anyone nothing else applies to. */
type Personal = Omit<AccessSources, 'roleKeys'>;

/** The client a read runs on: the cross-tenant pool by default, or a writer's own transaction. */
type Reader = Pick<Prisma.TransactionClient, 'userPermission'>;

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

  /** {@link ofLoaded} for a page of people, in one read — what a list's `canAct` weighs. */
  async ofLoadedMany(users: readonly LoadedUser[], client: Reader = this.prisma): Promise<Map<string, UserAccess>> {
    const personal = await this.personalOf(users, client);
    return new Map(users.map((u) => [u.id, accessOf({ roleKeys: roleKeysOf(u), ...personal.get(u.id) })]));
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
    const rows = await this.prisma.userPermission.findMany({
      where: roleId ? { user: { roleId } } : {},
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((r) => r.userId);
  }

  /** What applies to each person beyond their role: the keys given to and taken from them (AC-1-l). */
  private async personalOf(users: readonly Pick<LoadedUser, 'id'>[], client: Reader): Promise<Map<string, Personal>> {
    const out = new Map<string, { given: string[]; taken: string[] }>();
    if (users.length === 0) return out;
    const rows = await client.userPermission.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      select: { userId: true, effect: true, permission: { select: { key: true } } },
    });
    for (const row of rows) {
      const entry = out.get(row.userId) ?? { given: [], taken: [] };
      (row.effect === 'take' ? entry.taken : entry.given).push(row.permission.key);
      out.set(row.userId, entry);
    }
    return out;
  }
}

function roleKeysOf(user: LoadedUser): string[] {
  return user.role?.rolePermissions?.map((rp) => rp.permission.key) ?? [];
}
