import { ConfigProtocol, PanelOwnershipType, QuarantineReason } from '@prisma/client';
import { z } from 'zod';

/**
 * F-027-m — **the wire a collection pass leaves `network-service` on.**
 *
 * The collector is Go (ADR-0071) and is not in the Nx workspace, so nothing
 * imports anything across that boundary. The routing key and every field of
 * the message are declared in `contracts/network/delta.json`, and each side is
 * held to it by a test — `usage-delta.contract.spec.ts` here,
 * `internal/publish/delta_contract_test.go` there. It is the `wire.json`
 * pattern, for the reason ADR-0036 gives: a name spelled twice in two
 * languages with nothing comparing the copies drifts, and this one drifts into
 * a delta that arrives worth nothing.
 *
 * Three things about the shape are load-bearing:
 *
 * - **One message is one pass over one panel**, carrying all three streams:
 *   what we believe, what we do not (`quarantines`) and what we could not
 *   place (`unattributed`). Every measured byte is billed, held or
 *   quarantined — never dropped (network invariant 18) — so a message that
 *   carried only the deltas would break that invariant in the one place
 *   nothing goes red. A pass past {@link MAX_DELTAS_PER_MESSAGE} is chunked,
 *   and the other two streams ride the first chunk once.
 * - **A byte figure is a decimal string.** Both ends store it in a BIGINT and
 *   `JSON.parse` silently rounds past 2^53. The schemas below refuse a number
 *   rather than coerce one.
 * - **`deltaId` is derived from the delta, not generated.** It is
 *   `usage_delta_seen.deltaId`, so a redelivery carries the id its first
 *   delivery carried and the unique index absorbs the repeat (F-027-n). The
 *   derivation is in the fixture, which means a consumer can recompute it
 *   instead of trusting it.
 */

/** Every routing key `network-service` publishes under starts with this. A consumer binds `network.usage.#`. */
export const NETWORK_USAGE_ROUTING_PREFIX = 'network.usage.';

/** The key one collection pass is published under (C-08). */
export const USAGE_DELTA_ROUTING_KEY = `${NETWORK_USAGE_ROUTING_PREFIX}delta`;

/** `contracts/network/delta.json`'s `version`. A consumer refuses a version it was not written against. */
export const USAGE_DELTA_MESSAGE_VERSION = 1;

/** How many deltas one message may carry before the pass is chunked. */
export const MAX_DELTAS_PER_MESSAGE = 500;

/**
 * A BIGINT on the wire. Declared as a string in the fixture and refused as a
 * number here: by the time a JSON number this big has been parsed, the figure
 * that would be billed is already the wrong one.
 */
const byteString = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** RFC3339, UTC, as the collector stamped it. */
const timestamp = z.string().datetime({ offset: true });

const uuid = z.string().uuid();

/** One config's measured traffic for one interval. */
export const usageDeltaRowSchema = z.object({
  deltaId: uuid,
  configId: uuid,
  remoteId: z.string(),
  /** The config's protocol, carried so per-protocol cost needs no join (F-1002). */
  protocol: z.nativeEnum(ConfigProtocol),
  upBytes: byteString,
  downBytes: byteString,
  observedAt: timestamp,
  /** Set under `session` counter semantics, empty otherwise. */
  sessionId: z.string(),
  /** The counter had gone backward. The bytes are real; what ran before the reset was never measured (ADR-0074). */
  afterReset: z.boolean(),
});

/** A figure we measured and do not believe. `configId` is null where attribution is what failed. */
export const usageQuarantineRowSchema = z.object({
  deltaId: uuid,
  configId: uuid.nullable(),
  remoteId: z.string(),
  upBytes: byteString,
  downBytes: byteString,
  observedAt: timestamp,
  reason: z.nativeEnum(QuarantineReason),
});

/** Usage against a remote client no config claims. */
export const usageUnattributedRowSchema = z.object({
  remoteIdentifier: z.string(),
  upBytes: byteString,
  downBytes: byteString,
  observedAt: timestamp,
});

/** One pass over one panel. */
export const usageDeltaMessageSchema = z.object({
  version: z.number().int(),
  panelId: uuid,
  /** Who owns the panel the bytes crossed — the owner the bandwidth cost lands on (F-1002). */
  ownershipType: z.nativeEnum(PanelOwnershipType),
  /** Set exactly when the ownership is `tenant` (network invariant 9). */
  tenantId: uuid.nullable(),
  /** The pass's own clock: a bulk read is one request and therefore one moment (invariant 34). */
  observedAt: timestamp,
  chunk: z.number().int().positive(),
  chunks: z.number().int().positive(),
  deltas: z.array(usageDeltaRowSchema),
  quarantines: z.array(usageQuarantineRowSchema),
  unattributed: z.array(usageUnattributedRowSchema),
});

export type UsageDeltaRow = z.infer<typeof usageDeltaRowSchema>;
export type UsageQuarantineRow = z.infer<typeof usageQuarantineRowSchema>;
export type UsageUnattributedRow = z.infer<typeof usageUnattributedRowSchema>;
export type UsageDeltaMessage = z.infer<typeof usageDeltaMessageSchema>;
