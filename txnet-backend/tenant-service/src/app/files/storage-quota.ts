import { Injectable } from '@nestjs/common';
import { ResellerLimitReached, TenantContext, objectKey, resellerLimitOf, storageQuotaBytes, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

const MIB = 1024 * 1024;

/**
 * The refusal for `incoming` bytes past `storage_mib_max`, or `null` when they
 * fit (F-414-m, ADR-0120 point 2). `stored` already leaves out the file being
 * replaced. `used` in the refusal is what is stored now, in whole MiB.
 */
export function storageRefusal(limitMib: number | null, stored: number, incoming: number): ResellerLimitReached | null {
  if (limitMib === null || stored + incoming <= limitMib * MIB) return null;
  return new ResellerLimitReached('storage_mib_max', limitMib, Math.ceil(stored / MIB));
}

/**
 * A reseller's admins' uploads held to `storage_mib_max` (F-414-m, ADR-0120):
 * called before `ObjectStorage.put` of a branding image or a guide file, in
 * the tenant whose prefix the file goes under. The platform's tenant is
 * exempt (`resellerLimitOf`). The advisory lock orders checks, not writes: two
 * uploads at the same moment may pass the limit by one file.
 */
@Injectable()
export class StorageQuota {
  constructor(private readonly prisma: PrismaService) {}

  /** Throws `ResellerLimitReached` when `incoming` bytes at `path` would pass the limit. */
  async assertRoom(path: string, incoming: number): Promise<void> {
    const tenantId = TenantContext.current('storage quota').id;
    await tenantTransaction(this.prisma, async (tx) => {
      const { limit } = await resellerLimitOf(tx, tenantId, 'storage_mib_max');
      if (limit === null) return;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_limit:storage_mib_max:${tenantId}`}))`;
      const refused = storageRefusal(limit, await storageQuotaBytes(tx, tenantId, objectKey(tenantId, path)), incoming);
      if (refused) throw refused;
    });
  }
}
