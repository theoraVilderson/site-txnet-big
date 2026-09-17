import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  TENANT_STATUS_STORE,
  TenantStatusStore,
  parseTenantStatusState,
  tenantAllows,
} from '@txnet-backend/shared-core';
import { TickMessage } from '../broker/broker.service';
import { RedisKeys } from '../redis/redis.keys';
import { Job } from './job';

/**
 * `TenantStatusGuard` for a tick (F-018-p, tenant invariant 17). The HTTP guard
 * never sees background work, so a tick that names a tenant is judged here,
 * from the same `tenant:status:<id>` key and the same `TenantStatusPolicy`.
 *
 * A job acts as its `tenantCapability`, and one that declares none is a
 * `staffWrite` — closed for a suspended tenant, the HTTP default for a mutating
 * route. A platform tick (no `tenantId`) is not judged, and **a missing,
 * unreadable or unreachable key refuses nobody**: F-018-f's trade, since the
 * listener recomputes every tenant on each connect.
 */
@Injectable()
export class TenantStatusGate {
  private readonly logger = new Logger(TenantStatusGate.name);

  constructor(@Inject(TENANT_STATUS_STORE) private readonly store: TenantStatusStore) {}

  async allows(tick: TickMessage, job: Job): Promise<boolean> {
    if (!tick.tenantId) return true;
    let raw: string | null;
    try {
      raw = await this.store.get(RedisKeys.tenantStatus(tick.tenantId));
    } catch (err) {
      this.logger.warn(
        `tenant ${tick.tenantId} status unreadable for ${tick.key}, running it: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
    const state = parseTenantStatusState(raw);
    if (!state) return true;
    return tenantAllows(state, job.tenantCapability ?? 'staffWrite');
  }
}
