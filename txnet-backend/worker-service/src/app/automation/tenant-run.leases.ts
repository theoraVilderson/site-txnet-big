import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisKeys } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';

/**
 * Take a lease on one of a tenant's run slots, if one is free — **atomically**,
 * because every `worker-service` replica asks the same question of the same
 * key at the same time.
 *
 * KEYS[1] the tenant's lease set
 * ARGV[1] now, ms          ARGV[3] the new lease's token
 * ARGV[2] the cap          ARGV[4] the new lease's deadline, ms
 *
 * The prune comes first and is the reason this is one script rather than three
 * commands: read-then-write from N replicas is the classic lost update, and
 * here the lost update is a tenant holding cap+1 slots — which is the bug the
 * whole row exists to fix, reintroduced one layer down.
 *
 * The key's own TTL is re-armed to the lease length on every grant, so a
 * tenant that stops working leaves nothing behind. It cannot expire early:
 * every member's deadline is at most `now + lease`, so the key always outlives
 * its last live member.
 */
const ACQUIRE_LEASE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) - tonumber(ARGV[1]))
return 1
`;

/**
 * The shared half of the per-tenant concurrency cap (F-067-e, D-17).
 *
 * F-066-p counted in a `Map` on the process, which is one budget per replica —
 * a cap that stops meaning anything at exactly the scale it was built for.
 * This is the same arithmetic against a key every replica can see.
 *
 * It is deliberately **only** storage: it grants and returns leases and knows
 * nothing about ticks, deferrals or dead letters. `TenantConcurrencyGate`
 * keeps every decision, which is what leaves that decision testable without a
 * Redis.
 */
@Injectable()
export class TenantRunLeases {
  private readonly leaseMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    // The same number a run is assumed dead at. A lease that outlived it would
    // hold a slot for a run `closeAbandonedRuns` has already written off; one
    // that expired sooner would hand a second replica a slot a live run is
    // still using.
    this.leaseMs = config.getOrThrow<number>('AUTOMATION_RUN_TIMEOUT_MS');
  }

  /** The lease token, or `null` when the tenant is already at `cap`. */
  async acquire(tenantId: string, cap: number): Promise<string | null> {
    const now = Date.now();
    const token = randomUUID();
    const granted = await this.redis.evalScript<number>(
      ACQUIRE_LEASE,
      [RedisKeys.tenantRuns(tenantId)],
      [now, cap, token, now + this.leaseMs],
    );
    return granted === 1 ? token : null;
  }

  /**
   * Hand one lease back. Removing the member is enough — the key expires on
   * its own once the last one is gone, so there is nothing to clean up and no
   * moment at which a delete could race a concurrent grant.
   */
  release(tenantId: string, token: string): Promise<void> {
    return this.redis.zrem(RedisKeys.tenantRuns(tenantId), token);
  }

  /** Live leases for a tenant, expired ones excluded. For a log line. */
  count(tenantId: string): Promise<number> {
    return this.redis.zcount(RedisKeys.tenantRuns(tenantId), Date.now());
  }
}
