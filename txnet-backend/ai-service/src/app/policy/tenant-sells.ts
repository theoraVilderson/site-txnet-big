import { Logger } from '@nestjs/common';
import {
  parseTenantStatusState,
  tenantAllows,
  UnscopedRedisKeys,
  type TenantStatusStore,
} from '@txnet-backend/shared-core';

const logger = new Logger('tenantMaySell');

/**
 * Whether a tenant may sell right now (F-038-x) — the `sell` cell of
 * `TenantStatusPolicy`, from the `tenant:status:<id>` key `TenantStatusGuard`
 * reads. Closed for suspended, terminated and onboarding tenants, so the
 * engine never suggests a purchase their checkout would refuse.
 *
 * A missing, unreadable or unreachable key refuses nobody: F-018-f's trade,
 * the same one `worker-service`'s `TenantStatusGate` makes.
 */
export async function tenantMaySell(store: TenantStatusStore, tenantId: string): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await store.get(UnscopedRedisKeys.tenantStatus(tenantId));
  } catch (err) {
    logger.warn(`tenant ${tenantId} status unreadable, running: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
  const state = parseTenantStatusState(raw);
  return state ? tenantAllows(state, 'sell') : true;
}
