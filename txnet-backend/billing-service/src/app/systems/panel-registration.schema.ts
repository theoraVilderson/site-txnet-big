import { CounterSemantics, DriverType, PanelRole, PanelTransport } from '@prisma/client';
import { z } from 'zod';

/**
 * The wire shape of registering a panel (F-027-ar).
 *
 * **`.strict()`.** An unknown key is refused, not dropped: `reviewState`,
 * `capabilities`, `tenantId` and `ownershipType` are exactly what a client
 * might send expecting it to land, and each is someone else's to write — the
 * connection test's, or the owner rule's.
 *
 * `credentials` is the panel's login, opaque (a password, a token, a JSON
 * pair — the driver family decides, F-027-ae), bounded and relayed once to the
 * vault. A pull panel needs the address we poll it at; the database refuses
 * one without it too (`panel_pull_has_base_url`), but a 400 naming the field
 * beats a 500 naming a constraint.
 */
export const registerPanelSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    ipAddress: z.union([z.string().ip({ version: 'v4' }), z.string().ip({ version: 'v6' })]),
    apiBaseUrl: z.string().url().max(500).nullable().optional(),
    driverType: z.nativeEnum(DriverType),
    counterSemantics: z.nativeEnum(CounterSemantics),
    transport: z.nativeEnum(PanelTransport),
    role: z.nativeEnum(PanelRole),
    region: z.string().trim().min(1).max(50),
    maxRequestsPerMinute: z.number().int().positive().max(6000).optional(),
    credentials: z.string().min(1).max(4096),
    radiusSecret: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine((body) => body.transport !== PanelTransport.pull || !!body.apiBaseUrl, {
    path: ['apiBaseUrl'],
    message: 'apiBaseUrl is required for a pull panel',
  })
  // A push panel's NAS signs accounting with a secret of its own (F-027-az):
  // required there, since without it the NAS never reaches the allowlist, and
  // refused on a pull panel, which has no NAS to hold it.
  .refine((body) => (body.transport === PanelTransport.push) === (body.radiusSecret !== undefined), {
    path: ['radiusSecret'],
    message: 'radiusSecret is required for a push panel and refused for a pull panel',
  });

export type RegisterPanelBody = z.infer<typeof registerPanelSchema>;

/**
 * Re-submitting a panel's login (F-027-au): the login alone, bounded as at
 * registration and not trimmed — a password may start or end with a space.
 * `.strict()`, so a body naming `reviewState` is refused, not dropped.
 */
export const resubmitCredentialsSchema = z.object({ credentials: z.string().min(1).max(4096) }).strict();

export type ResubmitCredentialsBody = z.infer<typeof resubmitCredentialsSchema>;

/** Re-submitting a push panel's RADIUS secret (F-027-az): bounded and untrimmed, as the login is. */
export const resubmitRadiusSecretSchema = z.object({ radiusSecret: z.string().min(1).max(4096) }).strict();

export type ResubmitRadiusSecretBody = z.infer<typeof resubmitRadiusSecretSchema>;

/** Which drift events the report lists: `open` is the unacknowledged ones — those still halting a panel. */
export const DRIFT_EVENT_STATES = ['open', 'all'] as const;

/** The drift report's query (F-027-as). `after` is the last id of the previous page. */
export const driftEventQuerySchema = z
  .object({
    state: z.enum(DRIFT_EVENT_STATES).optional(),
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type DriftEventQueryInput = z.infer<typeof driftEventQuerySchema>;

/**
 * Acknowledging a drift event. `.strict()`: who acknowledged and when come
 * from the gate and the clock, and a body naming either is refused, not
 * dropped. The note is why — the restore that explains the reset.
 */
export const acknowledgeDriftSchema = z
  .object({ note: z.string().trim().min(1).max(1000).optional() })
  .strict();

export type AcknowledgeDriftBody = z.infer<typeof acknowledgeDriftSchema>;

/** Which holds the queue lists: `pending` is the ones still waiting for a decision. */
export const HOLD_QUEUE_STATES = ['pending', 'all'] as const;

/** The holds queue's query (F-027-at). `after` is the last id of the previous page. */
export const holdQueueQuerySchema = z
  .object({
    state: z.enum(HOLD_QUEUE_STATES).optional(),
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type HoldQueueQueryInput = z.infer<typeof holdQueueQuerySchema>;

/** Releasing a hold. Who released comes from the gate; the note is optional, as on a drift acknowledgement. */
export const releaseHoldSchema = z
  .object({ note: z.string().trim().min(1).max(1000).optional() })
  .strict();

export type ReleaseHoldBody = z.infer<typeof releaseHoldSchema>;

/** Writing a hold off. The note is required: bytes that are never charged say why (ADR-0080 decision 3). */
export const writeOffHoldSchema = z
  .object({ note: z.string().trim().min(1).max(1000) })
  .strict();

export type WriteOffHoldBody = z.infer<typeof writeOffHoldSchema>;
