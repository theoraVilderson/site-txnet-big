import { Logger } from '@nestjs/common';
import { UnscopedRedisKeys } from '@txnet-backend/shared-core';

/**
 * Write the total unless the key already holds a larger one, and refresh the
 * TTL either way.
 *
 * `consumedBytes` only ever grows, so a larger stored value is the later
 * figure: two replicas commit deltas for one Grant, and the one that committed
 * first may reach Redis second. A plain `SET` would put the older total back.
 * `tonumber` is a double, exact to 2^53 bytes (8 PiB) — past any Grant.
 */
const SET_IF_LARGER = `
local stored = redis.call('GET', KEYS[1])
if stored and tonumber(stored) >= tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

/** The one command this publisher sends. ioredis satisfies it; the spec fakes it. */
export interface SubUsageClient {
  eval(script: string, numKeys: number, key: string, total: string, ttlSec: number): Promise<unknown>;
}

/**
 * Live usage for `/sub` (F-609-a): the Grant's committed `consumedBytes`,
 * pushed to `sub:usage:<grantId>` so `Subscription-Userinfo` is not as stale
 * as the cached render (sub-api contract, "Subscription-Userinfo").
 *
 * **Redis never costs a delta.** The delta is money and this is a usage bar,
 * so {@link publish} never throws: a failure is logged and the pass is acked
 * as it would have been. It is not retried either — the next delta for the
 * Grant carries a newer total anyway, and `/sub` falls back to the figure its
 * render was built with.
 *
 * Built by a factory in `metering.module.ts`, over {@link SubUsageRedis}.
 */
export class SubUsagePublisher {
  private readonly logger = new Logger(SubUsagePublisher.name);

  constructor(
    private readonly client: SubUsageClient,
    private readonly ttlSec: number,
  ) {}

  async publish(grantId: string, consumedBytes: bigint): Promise<void> {
    try {
      await this.client.eval(SET_IF_LARGER, 1, UnscopedRedisKeys.subUsage(grantId), consumedBytes.toString(), this.ttlSec);
    } catch (err) {
      this.logger.warn(`sub usage for grant ${grantId} not published: ${(err as Error).message}`);
    }
  }
}
