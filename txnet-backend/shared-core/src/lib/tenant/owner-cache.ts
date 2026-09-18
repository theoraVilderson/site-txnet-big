import { UnscopedRedisKeys } from '../redis/keys';

/** The one read this needs: every host the tenant answers on. A transaction client fits. */
export interface TenantDomainReader {
  tenantDomain: {
    findMany(args: {
      where: { tenantId: string };
      select: { domainValue: true };
    }): Promise<{ domainValue: string }[]>;
  };
}

export interface CacheKeyDeleter {
  del(key: string): Promise<unknown>;
}

/**
 * Forget every cached copy of `tenant.ownerUserId` (ADR-0059, F-061-k): the
 * `tenant:id:*` entry the resolver's owner-through-a-bot check reads, and the
 * `tenant:host:*` entry of every one of the tenant's hosts, which carries it
 * for the owner-on-their-own-domain check.
 *
 * **Call it from every write of `ownerUserId`**, inside the transaction that
 * makes it, with that transaction as `db` — reseller creation today, any owner
 * change tomorrow. The hosts are read from the rows, not passed in, so a caller
 * cannot forget one; a stale owner is a person admitted to a tenant that is no
 * longer theirs.
 *
 * Throws when Redis cannot be reached, so the write is refused rather than
 * committed under an owner the cache still names — the same rule as the host
 * invalidation (ADR-0025).
 */
export async function invalidateTenantOwner(
  db: TenantDomainReader,
  redis: CacheKeyDeleter,
  tenantId: string,
): Promise<void> {
  const domains = await db.tenantDomain.findMany({
    where: { tenantId },
    select: { domainValue: true },
  });
  await redis.del(UnscopedRedisKeys.tenantById(tenantId));
  for (const { domainValue } of domains) {
    await redis.del(UnscopedRedisKeys.tenantByHost(domainValue));
  }
}
