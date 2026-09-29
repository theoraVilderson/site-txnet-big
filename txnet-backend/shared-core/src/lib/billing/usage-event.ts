import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { OutboxEventType } from '../automation/routing-keys';
import { METER_KEYS } from '../catalog/meter';

/**
 * F-118-f — **usage intake** (D-58, ADR-0105 decision 5): one reported use of
 * a Grant's meter becomes a `usage_event` row and advances that Grant's
 * `grant_meter.consumed`. Rating (F-118-g) reads `consumed − billed`, so an
 * event counted twice is money taken twice — which is why the key is the
 * whole design.
 *
 * Two doors, one function (user, 2026-09-29):
 *
 * - **In-process** — {@link recordUsage}, called inside the caller's own
 *   tenant-bound transaction (the per-use door, F-118-h, commits through it).
 * - **The queue** — a reporter in another process writes an `outbox_event` of
 *   type {@link OutboxEventType.USAGE_EVENT} whose payload is
 *   {@link usageEventPayloadSchema}; `metering-service` consumes it and runs
 *   the same function under the meter's tenant.
 *
 * There is no HTTP door: `metering-service` holds the cross-tenant pool and
 * serves none (ADR-0077), and the platform has no service-to-service auth.
 */

/** Why a use is not recorded. Each is a thrown {@link UsageRefused}; a queued event dead-letters as evidence. */
export type UsageRefusal =
  /** No `grant_meter` row for `(grantId, meterKey)`: the Grant was not sold with this meter. */
  | 'meter_not_on_grant'
  /** `vpn.traffic`: its bytes arrive as collection deltas on the Grant's byte columns until F-118-l. */
  | 'meter_on_its_own_path'
  /** The reporter's key was already used for a different figure: one of the two is wrong. */
  | 'key_reused';

export class UsageRefused extends Error {
  constructor(readonly reason: UsageRefusal) {
    super(`usage refused: ${reason}`);
    this.name = 'UsageRefused';
  }
}

/** Meters whose usage does not enter here yet (ADR-0105 decision 12). */
const ON_THEIR_OWN_PATH: ReadonlySet<string> = new Set([METER_KEYS.vpnTraffic]);

/** `outbox_event.aggregate` of a usage event: it is about a Grant. */
export const USAGE_EVENT_AGGREGATE = 'entitlement.grant';

/** A use, as a reporter states it. `quantity` is in the meter's unit; the wire carries it as a decimal string. */
export const usageEventPayloadSchema = z.object({
  grantId: z.string().uuid(),
  meterKey: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/),
  quantity: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/, 'a whole number of units, at least 1')
    .transform((q) => BigInt(q)),
  occurredAt: z
    .string()
    .datetime({ offset: true })
    .transform((at) => new Date(at)),
  source: z.string().min(1).max(64),
  idempotencyKey: z.string().min(1).max(200),
});

/** A usage event as the relay publishes it: an `OutboxMessage` whose payload is the above. */
export const usageEventMessageSchema = z.object({
  id: z.string().uuid(),
  aggregate: z.literal(USAGE_EVENT_AGGREGATE),
  aggregateId: z.string().uuid(),
  type: z.literal(OutboxEventType.USAGE_EVENT),
  occurredAt: z.string().datetime({ offset: true }),
  payload: usageEventPayloadSchema,
});

export type UsageEvent = z.output<typeof usageEventPayloadSchema>;

export interface UsageRecorded {
  /** `duplicate`: this `(source, idempotencyKey)` was already recorded with the same figure. */
  outcome: 'recorded' | 'duplicate';
  /** The meter's `consumed` as this transaction sees it. */
  consumed: bigint;
}

/**
 * Record one use, inside `tx` — a transaction already bound to the tenant
 * (`tenantTransaction`), so RLS hides another tenant's meter as absent.
 *
 * The insert is `ON CONFLICT DO NOTHING` (`skipDuplicates`), never a caught
 * unique violation: a failed statement aborts a Postgres transaction, and this
 * one belongs to the caller. A concurrent copy waits on the first one's row
 * and then inserts nothing. Only an inserted row advances `consumed`.
 */
export async function recordUsage(tx: Prisma.TransactionClient, event: UsageEvent): Promise<UsageRecorded> {
  if (ON_THEIR_OWN_PATH.has(event.meterKey)) throw new UsageRefused('meter_on_its_own_path');

  const meter = { grantId: event.grantId, meterKey: event.meterKey };
  const row = await tx.grantMeter.findUnique({ where: { grantId_meterKey: meter }, select: { tenantId: true, consumed: true } });
  if (!row) throw new UsageRefused('meter_not_on_grant');

  const { count } = await tx.usageEvent.createMany({
    data: [
      {
        tenantId: row.tenantId,
        grantId: event.grantId,
        meterKey: event.meterKey,
        quantity: event.quantity,
        occurredAt: event.occurredAt,
        source: event.source,
        idempotencyKey: event.idempotencyKey,
      },
    ],
    skipDuplicates: true,
  });

  if (count === 0) {
    const first = await tx.usageEvent.findUnique({
      where: { source_idempotencyKey: { source: event.source, idempotencyKey: event.idempotencyKey } },
    });
    if (!first || !sameUse(first, event)) throw new UsageRefused('key_reused');
    return { outcome: 'duplicate', consumed: row.consumed };
  }

  const advanced = await tx.grantMeter.update({
    where: { grantId_meterKey: meter },
    data: { consumed: { increment: event.quantity } },
    select: { consumed: true },
  });
  return { outcome: 'recorded', consumed: advanced.consumed };
}

/** The same use: every figure the reporter stated is the one first recorded. */
function sameUse(a: UsageEvent, b: UsageEvent): boolean {
  return (
    a.grantId === b.grantId &&
    a.meterKey === b.meterKey &&
    a.quantity === b.quantity &&
    a.occurredAt.getTime() === b.occurredAt.getTime()
  );
}
