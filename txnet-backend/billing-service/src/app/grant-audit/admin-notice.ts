import { Prisma } from '@prisma/client';
import { OutboxEventType, remainingLabel } from '@txnet-backend/shared-core';

import type { AdminRenewed } from '../entitlement/admin-renewal';
import type { DeviceLimitChange } from '../entitlement/devices';
import type { DurationChange } from '../entitlement/duration';
import { GRANT_AGGREGATE } from '../entitlement/delivered';
import type { TrafficChange } from '../entitlement/traffic';
import { PANEL_MY_SERVICES_PATH, panelUrlOf } from '../request/panel-url';
import type { SpeedChange } from '../traffic/grant-speed';
import type { ConfigAuditAction, GrantAuditAction } from './grant-audit';

const DAY_MS = 86_400_000;

type AdminNotice = { type: OutboxEventType; params: Record<string, string>; servicesUrl?: boolean };

/**
 * An act that also undid a stop the user was told of (F-601-k's test): said
 * inside this notice, as its closing line, so the user reads one message and
 * not "N days added" beside "active again". The act reported it and wrote no
 * `entitlement.grant.reactivated` of its own.
 */
const reactivated = (result: { reactivated?: boolean }) => (result.reactivated ? { reactivated: 'yes' } : {});

/**
 * What the user is told of an admin's act on their service (F-311-s): every
 * act on a Grant has one. Only the act's direction and size — never the
 * admin's reason, which is staff's, and never a rotated link.
 */
export function adminNoticeOf(action: GrantAuditAction, result: unknown): AdminNotice {
  switch (action) {
    case 'grant_freeze':
      return { type: OutboxEventType.GRANT_ADMIN_FROZEN, params: {} };
    case 'grant_unfreeze':
      return { type: OutboxEventType.GRANT_ADMIN_UNFROZEN, params: {} };
    case 'grant_duration_change': {
      const r = result as DurationChange;
      const moved = r.endsAtAfter.getTime() - r.endsAtBefore.getTime();
      const days = String(Math.max(1, Math.round(Math.abs(moved) / DAY_MS)));
      if (moved < 0) return { type: OutboxEventType.GRANT_ADMIN_DAYS_REMOVED, params: { days } };
      return { type: OutboxEventType.GRANT_ADMIN_DAYS_ADDED, params: { days, ...reactivated(r) } };
    }
    case 'grant_traffic_change':
    case 'grant_traffic_gift': {
      const r = result as TrafficChange;
      const moved = r.purchasedBytesAfter - r.purchasedBytesBefore;
      if (moved < BigInt(0)) return { type: OutboxEventType.GRANT_ADMIN_TRAFFIC_REMOVED, params: { amount: remainingLabel(-moved) } };
      return { type: OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED, params: { amount: remainingLabel(moved), ...reactivated(r) } };
    }
    case 'grant_traffic_reset':
      return { type: OutboxEventType.GRANT_ADMIN_TRAFFIC_RESET, params: reactivated(result as TrafficChange) };
    case 'grant_delete':
      return { type: OutboxEventType.GRANT_ADMIN_DELETED, params: {} };
    case 'grant_link_rotate':
      return { type: OutboxEventType.GRANT_ADMIN_LINK_ROTATED, params: {} };
    case 'grant_speed_set': {
      const { rateMbpsAfter } = result as SpeedChange;
      if (rateMbpsAfter === null) return { type: OutboxEventType.GRANT_ADMIN_SPEED_UNCAPPED, params: {} };
      return { type: OutboxEventType.GRANT_ADMIN_SPEED_CAPPED, params: { mbps: String(rateMbpsAfter) } };
    }
    case 'grant_devices_set': {
      const { limitAfter } = result as DeviceLimitChange;
      if (limitAfter === null) return { type: OutboxEventType.GRANT_ADMIN_DEVICES_UNLIMITED, params: {} };
      return { type: OutboxEventType.GRANT_ADMIN_DEVICES_LIMITED, params: { limit: String(limitAfter) } };
    }
    // Born `active`, so the purchase's "ready" (`markDelivered`, pending → active) never fires for it.
    case 'grant_issue':
      return { type: OutboxEventType.GRANT_ADMIN_ISSUED, params: {}, servicesUrl: true };
    case 'grant_renew':
      return { type: OutboxEventType.GRANT_ADMIN_RENEWED, params: reactivated(result as AdminRenewed) };
  }
}

/** One config's act (F-311-g), told on the config's Grant. */
export function configNoticeOf(action: ConfigAuditAction): AdminNotice {
  const type = {
    config_regenerate: OutboxEventType.GRANT_ADMIN_CONFIG_REGENERATED,
    config_disable: OutboxEventType.GRANT_ADMIN_CONFIG_DISABLED,
    config_enable: OutboxEventType.GRANT_ADMIN_CONFIG_ENABLED,
    config_retire: OutboxEventType.GRANT_ADMIN_CONFIG_RETIRED,
    config_move: OutboxEventType.GRANT_ADMIN_CONFIG_MOVED,
  }[action];
  return { type, params: {} };
}

/**
 * The notice as a retention outbox row, in the act's transaction (ADR-0021).
 * `period` is the act's audit row: one act, one ledger row, told once —
 * however often an admin freezes the same Grant (notification `contract.retention.md`).
 */
export async function emitAdminNotice(tx: Prisma.TransactionClient, tenantId: string, grantId: string, auditId: string, notice: AdminNotice): Promise<void> {
  const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { userId: true } });
  if (!grant) throw new Error(`grant ${grantId} was audited and is gone`);
  const servicesUrl = notice.servicesUrl ? await panelUrlOf(tx, tenantId, PANEL_MY_SERVICES_PATH) : null;
  await tx.outboxEvent.create({
    data: {
      aggregate: GRANT_AGGREGATE,
      aggregateId: grantId,
      type: notice.type,
      payload: { tenantId, userId: grant.userId, grantId, period: auditId, ...notice.params, ...(servicesUrl ? { servicesUrl } : {}) },
    },
    select: { id: true },
  });
}
