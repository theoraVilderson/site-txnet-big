import { z } from 'zod';

/**
 * F-027-dc — **the lease planner asking billing for a metered block**
 * (ADR-0093 amendment 2026-09-27).
 *
 * `network-service` sees the counter, so it knows when what a metered Grant
 * bought runs out inside the horizon; `billing-service` keeps the money, so it
 * decides whether a block is bought. The planner is Go and outside the Nx
 * workspace: the routing key and every field are declared in
 * `contracts/network/block-request.json`, and each side is held to it by a
 * test — `billing-service/src/app/traffic/block-request.spec.ts` here,
 * `network-service/internal/publish/block_request_test.go` there (ADR-0036).
 *
 * **Its own prefix.** `metering-service` binds `network.usage.#` and
 * dead-letters any key there that is not a pass or a release.
 *
 * **`purchasedBytes` is the bag the planner saw.** The consumer buys only while
 * the Grant still holds exactly that figure, so a request that arrives after
 * another block was bought is dropped rather than bought twice.
 */

/** Every key the lease planner publishes under starts with this. */
export const NETWORK_LEASE_ROUTING_PREFIX = 'network.lease.';

/** The key a block request is published under (C-08). */
export const BLOCK_REQUEST_ROUTING_KEY = `${NETWORK_LEASE_ROUTING_PREFIX}block_request`;

/** The fixture's `version`. A consumer refuses a version it was not written against. */
export const BLOCK_REQUEST_MESSAGE_VERSION = 1;

/** A BIGINT on the wire: a decimal string, never a number (as on the delta wire). */
const byteString = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const blockRequestMessageSchema = z.object({
  version: z.number().int(),
  grantId: z.string().uuid(),
  /** The bag the planner saw: `grant.purchasedBytes` when it asked. */
  purchasedBytes: byteString,
  /** A horizon of the measured rate, less what was left of the bag. */
  targetBytes: byteString,
  /** The rate the target was sized at, in bits a second; `0` = none measured (the overrun alone). */
  rateBps: byteString,
  requestedAt: z.string().datetime({ offset: true }),
});

export type BlockRequestMessage = z.infer<typeof blockRequestMessageSchema>;
