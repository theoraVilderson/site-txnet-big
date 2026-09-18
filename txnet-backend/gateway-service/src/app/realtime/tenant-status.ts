import { Injectable, Logger } from '@nestjs/common';
import { parseTenantStatusState, tenantAllows } from '@txnet-backend/shared-core';
import { RedisService, type FanoutSubscriberClient } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis.keys';
import { ConnectionRegistry, type Connection } from './connection.registry';

/** What this class needs of `RedisService`, and nothing more. */
export interface TenantStatusRedis {
  readonly keyPrefix: string;
  readonly subscriber: FanoutSubscriberClient;
  get(key: string): Promise<string | null>;
}

/**
 * A socket exists only while its tenant's status allows `read` (F-018-r,
 * `tenant/rules.md`) — the one rule of `TenantStatusPolicy` a socket can break.
 *
 * A client frame only subscribes to a channel, which is a `read`, so this is
 * the whole of the matrix here: a suspended tenant still reads and keeps its
 * sockets; a terminated one does neither. Terminating **does not revoke a
 * session**, so without this the session re-check never fires and a
 * terminated reseller's panel keeps receiving pushes for the session's life.
 *
 * Three moments ask the question: the upgrade ({@link admits}), a published
 * change of one tenant ({@link listen}, which is what makes the close
 * immediate), and every session re-check tick ({@link sweep}), the backstop
 * for a message pub/sub dropped. **A missing or unreadable state refuses
 * nobody** — `TenantStatusGuard`'s trade (F-101-b): a Redis outage is not
 * evidence that every tenant was terminated.
 */
@Injectable()
export class TenantSocketWatch {
  private readonly logger = new Logger(TenantSocketWatch.name);

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly redis: RedisService,
  ) {}

  /** Whether a socket of this tenant may open, or stay open. */
  async admits(tenantId: string): Promise<boolean> {
    try {
      return await this.allowsRead(tenantId);
    } catch (err) {
      this.logger.error(`tenant status read failed for ${tenantId}: ${(err as Error).message}`);
      return true;
    }
  }

  /**
   * Hear every tenant status change, and hand the sockets to close to
   * `onClose`. Called once, from the gateway's `attach`. The subscription is
   * on the fan-out's subscriber connection — the only one here that may
   * `SUBSCRIBE` — and ioredis restores it after a reconnect.
   */
  async listen(onClose: (connections: Connection[]) => void): Promise<void> {
    const wire = `${this.redis.keyPrefix}${RedisKeys.tenantStatusChanged()}`;
    this.redis.subscriber.on('message', (channel, raw) => {
      if (channel !== wire || !raw) return;
      void this.sweep([raw]).then(onClose);
    });
    try {
      await this.redis.subscriber.subscribe(wire);
    } catch (err) {
      // Not fatal: the re-check tick's sweep still closes them, one tick late.
      this.logger.error(`could not subscribe to ${wire}: ${(err as Error).message}`);
    }
  }

  /**
   * The connections whose tenant no longer allows `read` — among `tenantIds`,
   * or every tenant this replica holds a socket for. One read per distinct
   * tenant, not per connection; a tenant whose state cannot be read is left
   * open until the next tick.
   */
  async sweep(tenantIds?: string[]): Promise<Connection[]> {
    const closing: Connection[] = [];
    for (const tenantId of tenantIds ?? this.registry.tenants()) {
      let allowed: boolean;
      try {
        allowed = await this.allowsRead(tenantId);
      } catch (err) {
        this.logger.error(`tenant status re-check failed for ${tenantId}: ${(err as Error).message}`);
        continue;
      }
      if (!allowed) closing.push(...this.registry.byTenant(tenantId));
    }
    return closing;
  }

  private async allowsRead(tenantId: string): Promise<boolean> {
    const state = parseTenantStatusState(await this.redis.get(RedisKeys.tenantStatus(tenantId)));
    return !state || tenantAllows(state, 'read');
  }
}
