import { createHash } from 'node:crypto';
import { z } from 'zod';

import { OutboxEventType } from './routing-keys';

/**
 * F-027-at — **a released hold, on its way to the meter** (ADR-0080 decision 3).
 *
 * `billing-service` writes the release as an `outbox_event` of type
 * {@link OutboxEventType.USAGE_RELEASE}; the relay publishes it under
 * `outboxRoutingKey(type)` and `metering-service` binds that key beside
 * `network.usage.#`. Both ends are Nx apps, so the wire lives here (C-08).
 *
 * **The message carries who and why, never bytes.** The consumer reads the
 * figure from the `usage_hold` row itself, so a release cannot bill a number
 * the hold did not hold.
 *
 * **The delta id is derived from the hold**, the way a collected delta's is
 * derived from the delta (`contracts/network/delta.json`): the outbox relay is
 * at-least-once and an owner may click twice, and every copy of one release
 * carries the same `usage_delta_seen.deltaId`.
 */

/** `outbox_event.aggregate` of a release: the row it is about is a `network.usage_hold`. */
export const USAGE_RELEASE_AGGREGATE = 'network.usage_hold';

/**
 * The UUIDv5 namespace a release's delta id is derived under. Its own, not the
 * collector's `deltaIdNamespace`, so a release id can never equal a measured
 * delta's however the two names are spelled.
 */
export const USAGE_RELEASE_ID_NAMESPACE = '3f8e2c1a-7b4d-5e6f-8a9b-0c1d2e3f4a5b';

/** The `usage_delta_seen.deltaId` a release of this hold is applied under. Same hold, same id. */
export function usageReleaseDeltaId(holdId: string): string {
  const namespace = Buffer.from(USAGE_RELEASE_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespace).update(`release|${holdId}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const uuid = z.string().uuid();

/** `outbox_event.payload` of a release. */
export const usageReleasePayloadSchema = z.object({
  holdId: uuid,
  /** Who released it — written to `usage_hold.resolvedByAdminId` by the consumer. */
  adminId: uuid,
  note: z.string().nullable(),
});

/** A release as the relay publishes it: an `OutboxMessage` whose payload is the above. */
export const usageReleaseMessageSchema = z.object({
  id: uuid,
  aggregate: z.literal(USAGE_RELEASE_AGGREGATE),
  aggregateId: uuid,
  type: z.literal(OutboxEventType.USAGE_RELEASE),
  occurredAt: z.string().datetime({ offset: true }),
  payload: usageReleasePayloadSchema,
});

export type UsageReleasePayload = z.infer<typeof usageReleasePayloadSchema>;
export type UsageReleaseMessage = z.infer<typeof usageReleaseMessageSchema>;
