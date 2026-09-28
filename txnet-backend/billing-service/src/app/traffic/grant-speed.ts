import { DesiredRemote, GrantStatus, Prisma } from '@prisma/client';

import { EntitlementRefused } from '../entitlement/grant';
import { capabilityMatrix } from '../systems/capabilities';

/** A Grant only a renewal brings back (§4.4 one way): its speed is nobody's to set. */
const CLOSED: readonly GrantStatus[] = [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled];

/** A cap refused because of where the Grant is served, not what it is. */
export type SpeedCapRejection = 'rate_limit_unsupported' | 'no_configs';

export class SpeedCapRefused extends Error {
  constructor(
    readonly reason: SpeedCapRejection,
    /** The panels that cannot hold a cap, named so the admin knows which configs to move. */
    readonly panels: { id: string; name: string }[] = [],
  ) {
    super(panels.length ? `${reason}: ${panels.map((p) => p.name).join(', ')}` : reason);
    this.name = 'SpeedCapRefused';
  }
}

export type SpeedChange = { grantId: string; rateMbpsBefore: number | null; rateMbpsAfter: number | null };

/**
 * An admin sets or lifts a Grant's speed cap (F-311-p), in the caller's
 * transaction. The cap is `network.grant_rate_limit`, one row per Grant and
 * none for no cap; the convergence pass writes it to every config's client
 * through `SetClientRateLimit` (network `contract.provisioning.md`).
 *
 * **A cap is only promised where it is enforced.** Every panel the Grant has
 * a live config on must answer `per_client_rate_limit` yes in its current
 * capability document; one that says no, or has not been asked, is
 * `rate_limit_unsupported` with the panels named, and nothing is written.
 * Lifting a cap is never refused: no cap is what every panel enforces.
 * A config placed later on a panel with no cap carries the row unenforced —
 * the capability's own stated cost (`contracts/network/capabilities.json`).
 */
export async function setGrantSpeed(
  tx: Prisma.TransactionClient,
  grantId: string,
  input: { mbps: number | null; reason: string; actorUserId: string; at: Date },
): Promise<SpeedChange> {
  const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { id: true, status: true } });
  if (!grant) throw new EntitlementRefused('grant_not_found', grantId);
  if (CLOSED.includes(grant.status)) throw new EntitlementRefused('grant_closed', grant.status);
  if (grant.status !== GrantStatus.active && grant.status !== GrantStatus.suspended) throw new EntitlementRefused('grant_not_active', grant.status);

  const before = await tx.grantRateLimit.findUnique({ where: { grantId }, select: { rateMbps: true } });
  const rateMbpsBefore = before?.rateMbps ?? null;

  if (input.mbps === null) {
    await tx.grantRateLimit.deleteMany({ where: { grantId } });
    return { grantId, rateMbpsBefore, rateMbpsAfter: null };
  }

  const configs = await tx.config.findMany({
    where: { grantId, desiredRemote: DesiredRemote.present },
    select: { panel: { select: { id: true, name: true, transport: true, capabilities: true } } },
  });
  if (configs.length === 0) throw new SpeedCapRefused('no_configs');
  const refusing = new Map<string, { id: string; name: string }>();
  for (const { panel } of configs) {
    const row = capabilityMatrix(panel.capabilities, panel.transport).rows.find((r) => r.key === 'per_client_rate_limit');
    if (row?.state !== 'supported') refusing.set(panel.id, { id: panel.id, name: panel.name });
  }
  if (refusing.size > 0) throw new SpeedCapRefused('rate_limit_unsupported', [...refusing.values()]);

  const written = { rateMbps: input.mbps, reason: input.reason, setByAdminId: input.actorUserId, setAt: input.at };
  await tx.grantRateLimit.upsert({ where: { grantId }, create: { grantId, ...written }, update: written });
  return { grantId, rateMbpsBefore, rateMbpsAfter: input.mbps };
}
