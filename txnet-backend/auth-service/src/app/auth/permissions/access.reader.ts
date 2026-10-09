import { Injectable } from '@nestjs/common';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { accessOf, type AccessSources, type UserAccess } from './access';

/** The role keys `TokenService` mints from, as every caller loads them. */
type LoadedUser = { id: string; tenantId: string; role?: { rolePermissions?: { permission: { key: string } }[] } | null };

const ROLE_KEYS = { role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } } } as const;

/** Sources beyond the role, per person; empty for anyone nothing else applies to. */
type Personal = Omit<AccessSources, 'roleKeys'>;

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

  /** The answer for a user whose role keys are already loaded (every sign-in path loads them). */
  async ofLoaded(user: LoadedUser): Promise<UserAccess> {
    const personal = await this.personalOf([user]);
    return accessOf({ roleKeys: roleKeysOf(user), ...personal.get(user.id) });
  }

  /** The answer for these people, read in one pass — absent ids are left out. */
  async ofIds(userIds: readonly string[]): Promise<Map<string, UserAccess>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, tenantId: true, ...ROLE_KEYS },
    });
    const personal = await this.personalOf(users);
    return new Map(users.map((u) => [u.id, accessOf({ roleKeys: roleKeysOf(u), ...personal.get(u.id) })]));
  }

  /**
   * Everyone something beyond their role applies to, optionally only those
   * whose answer a change to `roleId` reaches — held directly or through a
   * group. What the writer recomputes after a role edit (ADR-0138 (5)).
   */
  async personalPeople(_roleId?: string): Promise<string[]> {
    return [];
  }

  /** What applies to each person beyond their role. Nothing yet: AC-1-l and AC-1-m add the sources. */
  private async personalOf(_users: readonly Pick<LoadedUser, 'id' | 'tenantId'>[]): Promise<Map<string, Personal>> {
    return new Map();
  }
}

function roleKeysOf(user: LoadedUser): string[] {
  return user.role?.rolePermissions?.map((rp) => rp.permission.key) ?? [];
}
