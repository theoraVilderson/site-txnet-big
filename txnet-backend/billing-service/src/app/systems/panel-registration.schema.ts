import { CounterSemantics, DriverType, InboundPlacement, PanelRole, PanelTransport } from '@prisma/client';
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
    ipAddress: z.union([z.string().ip({ version: 'v4' }), z.string().ip({ version: 'v6' })]).optional(),
    apiBaseUrl: z.string().url().max(500).nullable().optional(),
    clientBaseUrl: z.string().trim().url().max(500).nullable().optional(),
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
  // Only a push panel's address is read: it is its NAS's allowlist entry
  // (F-027-br). A pull panel is reached at `apiBaseUrl`, so its IP is optional;
  // the database refuses a push panel without one too (`panel_push_has_ip_address`).
  .refine((body) => body.transport !== PanelTransport.push || !!body.ipAddress, {
    path: ['ipAddress'],
    message: 'ipAddress is required for a push panel',
  })
  // A push panel's NAS signs accounting with a secret of its own (F-027-az):
  // required there, since without it the NAS never reaches the allowlist, and
  // refused on a pull panel, which has no NAS to hold it.
  .refine((body) => (body.transport === PanelTransport.push) === (body.radiusSecret !== undefined), {
    path: ['radiusSecret'],
    message: 'radiusSecret is required for a push panel and refused for a pull panel',
  })
  // Where a family serves its users' links apart from its API (Hiddify's
  // client proxy path, F-027-bg). A push panel has no API to serve them beside,
  // and the database refuses one there too (`panel_client_base_url_is_pull_only`).
  .refine((body) => body.transport === PanelTransport.pull || !body.clientBaseUrl, {
    path: ['clientBaseUrl'],
    message: 'clientBaseUrl is refused for a push panel',
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

/** What `network.panel_ovpn_profile_is_bounded` allows, in bytes. */
export const MAX_OVPN_PROFILE_BYTES = 65536;

/**
 * A User Manager router's `.ovpn` (F-307-d), as its admin uploads it. Every
 * buyer on the router downloads this same file, so it must name a server
 * (`remote`), ask for the buyer's own login (`auth-user-pass`), and carry no
 * private key — a `<key>` block or a PEM private key would be one client's
 * identity handed to all of them. Untrimmed: it is the file as written.
 */
const ovpnProfileSchema = z
  .string()
  .min(1)
  .refine((text) => Buffer.byteLength(text, 'utf8') <= MAX_OVPN_PROFILE_BYTES, { message: 'ovpnProfile is over 64 KiB' })
  .refine((text) => /^\s*remote\s+\S+/m.test(text), { message: 'ovpnProfile names no remote server' })
  .refine((text) => /^\s*auth-user-pass\b/m.test(text), { message: 'ovpnProfile does not ask for a login (auth-user-pass)' })
  .refine((text) => !/<key>|PRIVATE KEY-----/i.test(text), { message: 'ovpnProfile carries a private key; every buyer would get it' });

/**
 * Editing a panel's settings (F-027-by): any of them, at least one, bounded as
 * at registration. `.strict()`: `transport`, `driverType`, `reviewState` and
 * the secrets are refused, not dropped — a transport or family change is
 * another panel, the verdict is the test's, and a secret has its own route.
 * `apiBaseUrl` cannot be cleared: a pull panel is reached there. Which fields
 * a push panel may take is the service's to say, since it reads the row, and
 * so is which family may hold an `ovpnProfile` (F-307-d).
 */
export const updatePanelSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(50),
    ipAddress: z.union([z.string().ip({ version: 'v4' }), z.string().ip({ version: 'v6' })]).nullable(),
    apiBaseUrl: z.string().url().max(500),
    clientBaseUrl: z.string().trim().url().max(500).nullable(),
    maxRequestsPerMinute: z.number().int().positive().max(6000),
    ovpnProfile: ovpnProfileSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'name one field to change' });

export type UpdatePanelBody = z.infer<typeof updatePanelSchema>;

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

/**
 * A panel group's settings (F-027-bw, network `contract.groups.md`), inside
 * the table's CHECKs (`>= 1`, `> 0`), so a 400 names the field before a 500
 * names the constraint. A subscription lifetime runs a minute to a week: a
 * drain waits twice it, and a longer one would hold a panel for weeks. `.strict()`: `strategy` is refused, not dropped — only `mirror`
 * has a fulfilment (rule 7), and `tenantId` is the scope's to write. There is
 * no `protocol`: a group sells what its panels' picked inbounds do (F-114-b).
 */
const panelGroupFields = {
  name: z.string().trim().min(1).max(100),
  minHealthyPanels: z.number().int().min(1).max(100),
  subscriptionTtlSeconds: z.number().int().min(60).max(7 * 24 * 3600),
};

export const createPanelGroupSchema = z
  .object({
    name: panelGroupFields.name,
    minHealthyPanels: panelGroupFields.minHealthyPanels.optional(),
    subscriptionTtlSeconds: panelGroupFields.subscriptionTtlSeconds.optional(),
  })
  .strict();

export type CreatePanelGroupBody = z.infer<typeof createPanelGroupSchema>;

/** Editing a group: any of the three, at least one. */
export const updatePanelGroupSchema = createPanelGroupSchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'name one field to change' });

export type UpdatePanelGroupBody = z.infer<typeof updatePanelGroupSchema>;

/**
 * Adding a panel to a group. `.strict()`: `role` is refused — a member enters
 * as `primary`, and `drain` is its own route, whose clock the database keeps.
 */
export const addPanelGroupMemberSchema = z
  .object({
    panelId: z.string().uuid(),
    priority: z.number().int().min(0).max(1000).optional(),
    weight: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export type AddPanelGroupMemberBody = z.infer<typeof addPanelGroupMemberSchema>;

/**
 * A panel's inbound picks and placement (F-114-b, network `contract.inbounds.md`).
 * A cap is `>= 1` or null (none), as the table's CHECKs; a pick names the
 * inbound by the panel's own id. `.strict()`: the read's columns (`protocol`,
 * `enabled`, `goneAt`) are the panel's and are refused, not dropped.
 */
const capSchema = z.number().int().min(1).max(1_000_000).nullable();

export const updatePanelInboundsSchema = z
  .object({
    inboundPlacement: z.nativeEnum(InboundPlacement).optional(),
    maxClients: capSchema.optional(),
    inbounds: z
      .array(z.object({ remoteId: z.string().min(1).max(200), sold: z.boolean(), maxClients: capSchema.optional() }).strict())
      .max(500)
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'name one field to change' })
  .refine((body) => new Set((body.inbounds ?? []).map((i) => i.remoteId)).size === (body.inbounds ?? []).length, {
    message: 'an inbound is named twice',
    path: ['inbounds'],
  });

export type UpdatePanelInboundsBody = z.infer<typeof updatePanelInboundsSchema>;
