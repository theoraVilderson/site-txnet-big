import { z } from 'zod';

import { OutboxEventType } from './routing-keys';

/**
 * F-1001-f — **a user signed up, on its way to analytics**
 * (billing/contract.analytics.md "Rollup tables").
 *
 * identity writes the event in the transaction that creates the user;
 * `metering-service` (billing's consumer) records one `analytics_signup` row
 * per user. Billing never reads identity's tables for it. Both ends are Nx
 * apps, so the wire lives here (C-08). A redelivery writes nothing: the row is
 * keyed by the user.
 */

/** `outbox_event.aggregate` of a signup: the row it is about is an `identity.user`. */
export const USER_SIGNED_UP_AGGREGATE = 'identity.user';

/** Where the signup came through when no bot proved the phone. */
export const WEB_SIGNUP_SOURCE = 'web';

const uuid = z.string().uuid();

/** `outbox_event.payload` of a signup. */
export const userSignedUpPayloadSchema = z.object({
  tenantId: uuid,
  userId: uuid,
  /** When the user was created, ISO. */
  signedUpAt: z.string().datetime({ offset: true }),
  /** {@link WEB_SIGNUP_SOURCE}, or the bot platform that proved the phone. */
  source: z.string().min(1).max(32),
});

/** A signup as the relay publishes it: an `OutboxMessage` whose payload is the above. */
export const userSignedUpMessageSchema = z.object({
  id: uuid,
  aggregate: z.literal(USER_SIGNED_UP_AGGREGATE),
  aggregateId: uuid,
  type: z.literal(OutboxEventType.USER_SIGNED_UP),
  occurredAt: z.string().datetime({ offset: true }),
  payload: userSignedUpPayloadSchema,
});

export type UserSignedUpPayload = z.infer<typeof userSignedUpPayloadSchema>;
