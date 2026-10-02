import { Injectable, Logger } from '@nestjs/common';
import { UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { RedisService } from '../redis/redis.service';

/** The longest one switch may hold: a forgotten silence lifts itself within a week. */
export const SILENCE_MAX_MS = 7 * 24 * 3_600_000;

export type SilenceState = { silent: false } | { silent: true; until: Date | null };

/**
 * The platform's silence switch (F-1548, user 2026-10-02): during an outage
 * the platform hushes the engine, for everyone or for one tenant, until a set
 * end. It is how an outage reaches `ai-service` without it reading network
 * data (ADR-0109 point 6) — whatever detects the outage, a person today, sets
 * the switch. No tenant can see or clear it.
 *
 * Fails closed, unlike `tenantMaySell`: a held suggestion costs a little
 * revenue, a pitch sent into an outage costs the reseller's customer's trust.
 */
@Injectable()
export class SilenceSwitch {
  private readonly logger = new Logger(SilenceSwitch.name);

  constructor(private readonly redis: RedisService) {}

  async state(tenantId: string, now: Date): Promise<SilenceState> {
    let values: Array<string | null>;
    try {
      values = await this.redis.mget(UnscopedRedisKeys.aiSilenceAll(), UnscopedRedisKeys.aiSilence(tenantId));
    } catch (err) {
      this.logger.warn(`silence unreadable for tenant ${tenantId}, holding: ${err instanceof Error ? err.message : String(err)}`);
      return { silent: true, until: null };
    }
    // The key expires at its end; the value is checked too, so a clock ahead of Redis's never extends one.
    const ends = values
      .map((v) => (v === null ? NaN : Date.parse(v)))
      .filter((t) => !Number.isNaN(t) && t > now.getTime());
    return ends.length ? { silent: true, until: new Date(Math.max(...ends)) } : { silent: false };
  }

  /** Silence one tenant (or everyone, `null`) until `until`; `until` null lifts it. */
  async set(tenantId: string | null, until: Date | null, now: Date): Promise<void> {
    const key = tenantId ? UnscopedRedisKeys.aiSilence(tenantId) : UnscopedRedisKeys.aiSilenceAll();
    if (until === null) return this.redis.del(key);
    const ms = until.getTime() - now.getTime();
    if (ms <= 0 || ms > SILENCE_MAX_MS) throw new Error('until_out_of_range');
    await this.redis.setFor(key, until.toISOString(), ms);
  }
}
