import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, findKeyHolders, holdsPermission, platformTenantIdOf } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';

/** The most holders the boot warning names (C-28): far above any real count. */
const NAMED_MAX = 100;

/**
 * The live holders of `*` in `tenantId`, leaving out `exceptUserId` — asked
 * through `findKeyHolders` (C-15), so a holder by any source counts. `*` means
 * something only on the platform's own tenant (`isPlatformStaff`).
 */
function wildcardHolders(tx: Prisma.TransactionClient, tenantId: string, exceptUserId?: string): Promise<string[]> {
  return findKeyHolders(tx, tenantId, ALL_PERMISSIONS, { deletedAt: null, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) });
}

/**
 * SA-1-a (user 2026-10-14): giving a role that holds `*` to one more person
 * while `max` others in the tenant already hold it is `superadmin_limit`. Under
 * a transaction lock, so two such grants at once cannot both pass. `null` when
 * it may go ahead.
 */
export async function wildcardRefusal(
  tx: Prisma.TransactionClient,
  input: { roleKeys: readonly string[]; tenantId: string; userId: string; max: number },
): Promise<'superadmin_limit' | null> {
  if (!holdsPermission(input.roleKeys, '*')) return null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('identity.superadmin_holders'))`;
  const others = await wildcardHolders(tx, input.tenantId, input.userId);
  return others.length >= input.max ? 'superadmin_limit' : null;
}

/**
 * Says at boot when more people hold `*` than `SUPERADMIN_MAX`, naming them,
 * so an extra holder made outside the panel (a seed, a hand-edited row) is
 * seen. It removes no one: that is an operator's call.
 */
@Injectable()
export class WildcardHoldersWatch implements OnApplicationBootstrap {
  private readonly logger = new Logger(WildcardHoldersWatch.name);

  constructor(
    private readonly db: CrossTenantPrismaService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): Promise<void> {
    return this.check();
  }

  async check(): Promise<void> {
    const max = Number(this.config.get('SUPERADMIN_MAX'));
    const named = await this.db.$transaction(async (tx) => {
      const ids = await wildcardHolders(tx, await platformTenantIdOf(tx));
      if (ids.length <= max) return null;
      const rows = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true }, orderBy: { createdAt: 'asc' }, take: NAMED_MAX });
      return rows.map((u) => u.username ?? u.id);
    });
    if (named) this.logger.warn(`${named.length} people hold * (SUPERADMIN_MAX ${max}): ${named.join(', ')}`);
  }
}
