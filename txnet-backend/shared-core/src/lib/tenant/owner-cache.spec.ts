import { describe, expect, it, vi } from 'vitest';
import { UnscopedRedisKeys } from '../redis/keys';
import { invalidateTenantOwner } from './owner-cache';

const TENANT = 't-1';

function harness(domains: string[], del = vi.fn(async (_key: string) => undefined)) {
  const findMany = vi.fn(async () => domains.map((domainValue) => ({ domainValue })));
  return { db: { tenantDomain: { findMany } }, redis: { del }, findMany, del };
}

describe('invalidateTenantOwner — every cache entry that holds tenant.ownerUserId (F-061-k, ADR-0059)', () => {
  it('drops the id entry and the entry of every one of the tenant hosts, read from the rows', async () => {
    const h = harness(['rs1.txnet.test', 'rs1.cname.txnet.test', 'myvpn.com']);
    await invalidateTenantOwner(h.db, h.redis, TENANT);

    expect(h.findMany).toHaveBeenCalledWith({ where: { tenantId: TENANT }, select: { domainValue: true } });
    expect(h.del.mock.calls.map(([k]) => k).sort()).toEqual(
      [
        UnscopedRedisKeys.tenantById(TENANT),
        UnscopedRedisKeys.tenantByHost('rs1.txnet.test'),
        UnscopedRedisKeys.tenantByHost('rs1.cname.txnet.test'),
        UnscopedRedisKeys.tenantByHost('myvpn.com'),
      ].sort(),
    );
  });

  it('a tenant with no domain still loses its id entry', async () => {
    const h = harness([]);
    await invalidateTenantOwner(h.db, h.redis, TENANT);
    expect(h.del.mock.calls.map(([k]) => k)).toEqual([UnscopedRedisKeys.tenantById(TENANT)]);
  });

  it('a Redis that cannot be reached throws, so the owner write is refused rather than left stale', async () => {
    const h = harness(['rs1.txnet.test'], vi.fn(async () => { throw new Error('redis down'); }));
    await expect(invalidateTenantOwner(h.db, h.redis, TENANT)).rejects.toThrow('redis down');
  });
});
