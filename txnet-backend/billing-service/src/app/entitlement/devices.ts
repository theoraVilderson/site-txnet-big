import { DesiredRemote, GrantSource, GrantStatus, Prisma, QuotaMetric } from '@prisma/client';

import { capabilityMatrix } from '../systems/capabilities';
import { EntitlementRefused } from './grant';

/** A Grant only a renewal brings back (§4.4 one way): its limits are nobody's to set. */
const CLOSED: readonly GrantStatus[] = [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled];

export type DeviceLimitChange = {
  grantId: string;
  adjustmentId: string;
  limitBefore: number | null;
  limitAfter: number | null;
  /** Panels with a live config of the Grant that do not answer `per_client_ip_limit` yes: the limit is recorded, not held, there. */
  panelsNotEnforcing: { id: string; name: string }[];
};

type Quotas = Record<string, unknown>;

const quotasOf = (json: Prisma.JsonValue): Quotas => (json && typeof json === 'object' && !Array.isArray(json) ? (json as Quotas) : {});

/** `quotas.concurrent_devices.limit` when it is a positive whole number; anything else is no limit. */
export function deviceLimitOf(json: Prisma.JsonValue): number | null {
  const entry = quotasOf(json)[QuotaMetric.concurrent_devices];
  const limit = entry && typeof entry === 'object' ? (entry as { limit?: unknown }).limit : undefined;
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null;
}

/**
 * An admin sets or lifts a Grant's device limit (F-311-q), in the caller's
 * transaction: `quotas.concurrent_devices.limit`, the same entry a variant's
 * sold limit is copied into, so network's convergence pass has one figure to
 * write as the client's address limit (`limitIp`, network
 * `contract.provisioning.md`). `null` lifts it.
 *
 * One `quota_adjustment` row (invariant 3), conditional on the quotas it read.
 * **Not refused where it is not held** (user, 2026-09-28): the panels whose
 * capability document does not answer `per_client_ip_limit` yes are named in
 * the answer, and the limit waits there until the panel can hold one.
 */
export async function setGrantDeviceLimit(
  tx: Prisma.TransactionClient,
  grantId: string,
  input: { limit: number | null; reason: string; actorUserId: string; at: Date },
): Promise<DeviceLimitChange> {
  const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { id: true, tenantId: true, status: true, quotas: true } });
  if (!grant) throw new EntitlementRefused('grant_not_found', grantId);
  if (CLOSED.includes(grant.status)) throw new EntitlementRefused('grant_closed', grant.status);
  if (grant.status !== GrantStatus.active && grant.status !== GrantStatus.suspended) throw new EntitlementRefused('grant_not_active', grant.status);

  const limitBefore = deviceLimitOf(grant.quotas);
  const limitAfter = input.limit;
  if (limitBefore === limitAfter) throw new EntitlementRefused('devices_unchanged', grantId);

  const { [QuotaMetric.concurrent_devices]: entry, ...rest } = quotasOf(grant.quotas);
  const kept = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Quotas) : {};
  const next: Quotas = limitAfter === null ? rest : { ...rest, [QuotaMetric.concurrent_devices]: { ...kept, limit: limitAfter } };

  const moved = await tx.grant.updateMany({
    where: { id: grantId, quotas: { equals: grant.quotas ?? Prisma.JsonNull } },
    data: { quotas: next as Prisma.InputJsonValue },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved', grantId);

  const adjustment = await tx.quotaAdjustment.create({
    data: {
      tenantId: grant.tenantId,
      grantId,
      metric: QuotaMetric.concurrent_devices,
      delta: BigInt((limitAfter ?? 0) - (limitBefore ?? 0)),
      source: GrantSource.admin_grant,
      reason: input.reason,
      createdByAdminId: input.actorUserId,
    },
    select: { id: true },
  });

  const panelsNotEnforcing = new Map<string, { id: string; name: string }>();
  if (limitAfter !== null) {
    const configs = await tx.config.findMany({
      where: { grantId, desiredRemote: DesiredRemote.present },
      select: { panel: { select: { id: true, name: true, transport: true, capabilities: true } } },
    });
    for (const { panel } of configs) {
      const row = capabilityMatrix(panel.capabilities, panel.transport).rows.find((r) => r.key === 'per_client_ip_limit');
      if (row?.state !== 'supported') panelsNotEnforcing.set(panel.id, { id: panel.id, name: panel.name });
    }
  }
  return { grantId, adjustmentId: adjustment.id, limitBefore, limitAfter, panelsNotEnforcing: [...panelsNotEnforcing.values()] };
}
