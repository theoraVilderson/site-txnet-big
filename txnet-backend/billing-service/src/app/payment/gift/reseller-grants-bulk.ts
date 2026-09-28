import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { setGrantDeviceLimit } from '../../entitlement/devices';
import { changeGrantDuration } from '../../entitlement/duration';
import { freezeGrant, unfreezeGrant } from '../../entitlement/freeze';
import { EntitlementRefused } from '../../entitlement/grant';
import { adjustGrantTraffic, resetGrantTraffic, TrafficChange } from '../../entitlement/traffic';
import { AuditActor, auditedGrantAct, GrantAuditAction } from '../../grant-audit/grant-audit';
import { PrismaService } from '../../prisma/prisma.service';
import { giftGrantBytes } from '../../traffic/gift-bytes';
import { setGrantSpeed, SpeedCapRefused } from '../../traffic/grant-speed';
import { GrantBulkAction, GrantBulkBody } from './grant-bulk.schema';
import { bytesOfGb } from './grant-traffic.schema';

/** A throw nobody named: that Grant rolled back, the others stand. */
export const GRANT_BULK_FAILED = 'failed';

export type GrantBulkOutcome =
  | { grantId: string; userId: string; ok: true; result: Record<string, unknown> }
  | { grantId: string; ok: false; reason: string; panels?: { id: string; name: string }[] };

/** Each action's audit name: the single-Grant route's, so a Grant's history reads the same either way (F-311-r). */
const AUDIT: Record<GrantBulkAction, GrantAuditAction> = {
  freeze: 'grant_freeze',
  unfreeze: 'grant_unfreeze',
  days: 'grant_duration_change',
  traffic: 'grant_traffic_change',
  traffic_reset: 'grant_traffic_reset',
  traffic_gift: 'grant_traffic_gift',
  speed: 'grant_speed_set',
  devices: 'grant_devices_set',
};

const logger = new Logger('ResellerGrantsBulk');

/**
 * An admin's act on many users' Grants (F-311-u), inside the reseller's scope
 * the door already opened: **one transaction per Grant**, ids deduplicated, in
 * the order named — as the config actions (F-311-g). A refusal or a throw is
 * that Grant's outcome and the rest still run; the ones before it are
 * committed and must still be reported.
 *
 * **The fence is the Grant's `tenantId`** (C-15): there is no path user to
 * check, so a Grant is read by id *and* the reseller's tenant in the act's own
 * transaction. RLS hides another tenant's Grant too, but `grant` is not in
 * `TENANT_SCOPED_MODELS`, so the query says it rather than trusting the role.
 * Another reseller's Grant, or none, is `grant_not_found` and is not acted on.
 *
 * Each act is the single-Grant route's function and audit row (F-311-r), so
 * each user is told as if one admin acted on one Grant (F-311-s).
 */
export async function actOnEach(
  prisma: PrismaService,
  actor: AuditActor,
  tenantId: string,
  command: GrantBulkBody,
): Promise<GrantBulkOutcome[]> {
  const outcomes: GrantBulkOutcome[] = [];
  for (const grantId of new Set(command.grantIds)) {
    try {
      const done = await tenantTransaction(prisma, async (tx) => {
        const grant = await tx.grant.findFirst({ where: { id: grantId, tenantId }, select: { id: true, userId: true } });
        if (!grant) throw new EntitlementRefused('grant_not_found');
        const audited: Audited = (step) => auditedGrantAct(tx, actor, tenantId, grantId, { action: AUDIT[command.action], reason: command.reason, outcome: (r) => r }, step);
        return { userId: grant.userId, result: await act(tx, audited, actor.userId, grantId, command) };
      });
      outcomes.push({ grantId, userId: done.userId, ok: true, result: done.result });
    } catch (e) {
      if (e instanceof SpeedCapRefused) outcomes.push({ grantId, ok: false, reason: e.reason, panels: e.panels });
      else if (e instanceof EntitlementRefused) outcomes.push({ grantId, ok: false, reason: e.reason });
      else {
        logger.error(`grant ${command.action} failed for ${grantId}`, e instanceof Error ? e.stack : String(e));
        outcomes.push({ grantId, ok: false, reason: GRANT_BULK_FAILED });
      }
    }
  }
  return outcomes;
}

/** The act, written down with its raw result — the user's notice reads its Dates and bytes (F-311-s). */
type Audited = <T>(step: () => Promise<T>) => Promise<T>;

/** The single-Grant act, audited, and its result as the single route answers it (dates ISO, bytes as strings). */
async function act(tx: Prisma.TransactionClient, audited: Audited, actorUserId: string, grantId: string, command: GrantBulkBody): Promise<Record<string, unknown>> {
  const at = new Date();
  const { reason } = command;
  switch (command.action) {
    case 'freeze': {
      const r = await audited(() => freezeGrant(tx, grantId, { at, until: command.until ? new Date(command.until) : null }));
      return { frozenUntil: r.frozenUntil?.toISOString() ?? null, configsDisabled: r.configsDisabled };
    }
    case 'unfreeze': {
      const r = await audited(() => unfreezeGrant(tx, grantId, at));
      return { endsAt: r.endsAt?.toISOString() ?? null, configsRestored: r.configsRestored };
    }
    case 'days': {
      const r = await audited(() => changeGrantDuration(tx, grantId, { at, actorUserId, change: { days: command.days }, reason }));
      return { changeId: r.changeId, endsAtBefore: r.endsAtBefore.toISOString(), endsAtAfter: r.endsAtAfter.toISOString(), revived: r.revived };
    }
    case 'traffic':
      return bytes(await audited(() => adjustGrantTraffic(tx, grantId, { at, actorUserId, deltaBytes: bytesOfGb(command.gb), reason })));
    case 'traffic_reset': {
      const r = await audited(() => resetGrantTraffic(tx, grantId, { at, actorUserId, reason }));
      return { ...bytes(r), resetBytes: r.resetBytes.toString() };
    }
    case 'traffic_gift': {
      const { spent: _spent, ...r } = bytes(await audited(() => giftGrantBytes(tx, grantId, { at, actorUserId, bytes: bytesOfGb(command.gb), reason })));
      return r;
    }
    case 'speed': {
      const { rateMbpsBefore, rateMbpsAfter } = await audited(() => setGrantSpeed(tx, grantId, { mbps: command.mbps, reason, actorUserId, at }));
      return { rateMbpsBefore, rateMbpsAfter };
    }
    case 'devices': {
      const { adjustmentId, limitBefore, limitAfter, panelsNotEnforcing } = await audited(() => setGrantDeviceLimit(tx, grantId, { limit: command.limit, reason, actorUserId, at }));
      return { adjustmentId, limitBefore, limitAfter, panelsNotEnforcing };
    }
  }
}

const bytes = (r: TrafficChange) => ({
  adjustmentId: r.adjustmentId,
  purchasedBytesBefore: r.purchasedBytesBefore.toString(),
  purchasedBytesAfter: r.purchasedBytesAfter.toString(),
  usedBytes: r.usedBytes.toString(),
  spent: r.spent,
  revived: r.revived,
});
