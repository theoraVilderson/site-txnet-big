import { ResellerAccess, ResellerAccessRefused, type ResellerActor } from '@txnet-backend/shared-core';

import { ResellerUserGrantsRefused } from '../payment/gift/reseller-user-grants.service';

/** The import's door, `migration.manage` (tenant `contract.source-login.md` rule 2): `staffWrite` to change, `read` to look. */
export async function admitMigration<T>(
  access: ResellerAccess,
  at: { actor: ResellerActor; tenantId: string; capability: 'read' | 'staffWrite' },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await access.for('migration.manage').run(at.actor, at.tenantId, at.capability, work);
  } catch (e) {
    // The door's reasons are every reseller route's (`resellerRefusal`).
    if (e instanceof ResellerAccessRefused) throw new ResellerUserGrantsRefused(e.reason, at.tenantId);
    throw e;
  }
}
