import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { tenantChannel } from "@/lib/realtime";
import type {
  CapabilityRow,
  ConnectionTestFault,
  HoldReason,
  PanelReviewState,
  PanelState,
  RegisterPanelBody,
  ResubmittedLogin,
  SystemsDriftEvent,
  SystemsHold,
  SystemsPanel,
} from "@/lib/billing-api";

/** Every string the systems page can show (C-06). */
export const SYSTEMS_KEYS = FrontendI18nKeys.common.systems;
const K = SYSTEMS_KEYS;

/** billing's `PANEL_MANAGE` — the menu entry needs it (F-027-ar). */
export const PANEL_MANAGE = "panel.manage";

/** gateway-service's `TENANT_CHANNEL_PERMISSION`: the `tenant:` channel needs it. */
export const REALTIME_TENANT_READ = "realtime.tenant.read";

/**
 * The channel a connection test's verdict or fault arrives on (F-027-bs), or
 * null when the gateway would refuse it — then the page reads on load, as it
 * always did. `*` holds every permission, as `visibleMenu` reads it.
 */
export function liveChannelOf(me: { tenant: { id: string }; permissions: readonly string[] } | null): string | null {
  if (!me) return null;
  const held = me.permissions.includes("*") || me.permissions.includes(REALTIME_TENANT_READ);
  return held ? tenantChannel(me.tenant.id) : null;
}

/**
 * A filter, not a parser: `automation` pushes `{type:'network.panel.tested',
 * panelId, reviewState, fault}` and the page re-reads `GET /systems/panels`
 * for the row, so what is shown is still only what billing reads back.
 */
export function isPanelTested(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as Record<string, unknown>).type === RealtimeEvents.panelTested;
}

// The closed sets the register form offers, as `network.prisma` declares them
// (C-09). `systems.test.ts` reads each enum out of the schema.
export const DRIVER_TYPES = [
  "marzban",
  "marzneshin",
  "sanaee",
  "x_ui_alireza",
  "x_ui_vaxilu",
  "three_x_ui",
  "s_ui",
  "hiddify",
  "core_xray",
  "ibsng",
  "cloudius",
  "mikrotik_user_manager",
  "mikrotik_wireguard",
  "fake",
] as const;

/**
 * The product each family is, as its operator knows it. Product names, not
 * prose, so not translated (C-06 is for `t()` keys). `sanaee` and
 * `three_x_ui` are one product's v2 and v3, whose APIs differ (F-027-bb): the
 * form must tell them apart, and the enum values alone do not. The two x-ui
 * forks are named by their authors, as operators know them (F-027-bc).
 */
export const DRIVER_LABELS: Record<(typeof DRIVER_TYPES)[number], string> = {
  marzban: "Marzban",
  marzneshin: "Marzneshin",
  sanaee: "3x-ui v2.x (MHSanaei)",
  x_ui_alireza: "x-ui (alireza0)",
  x_ui_vaxilu: "x-ui (vaxilu)",
  three_x_ui: "3x-ui v3.x (MHSanaei)",
  s_ui: "S-UI",
  hiddify: "Hiddify Manager",
  core_xray: "Xray core",
  ibsng: "IBSng",
  cloudius: "Cloudius",
  mikrotik_user_manager: "MikroTik User Manager",
  mikrotik_wireguard: "MikroTik WireGuard",
  fake: "fake",
};

/** A panel row's family by name; a value this build does not know shows as sent. */
export function driverLabel(driverType: string): string {
  return (DRIVER_LABELS as Record<string, string>)[driverType] ?? driverType;
}
export const COUNTER_SEMANTICS = ["cumulative", "session", "reset_on_read"] as const;
export const PANEL_TRANSPORTS = ["pull", "push"] as const;
export const PANEL_ROLES = ["active", "passive"] as const;

/**
 * One sentence per value the loops can write. Each is a `Record` over the
 * union, so a value added to the wire type does not compile here, and the test
 * reads the Prisma enum to catch the case where both sides forgot.
 */
export const REVIEW_KEYS: Record<PanelReviewState, string> = {
  pending: K.review.pending,
  accepted: K.review.accepted,
  accepted_low_trust: K.review.accepted_low_trust,
  refused: K.review.refused,
};

export const PANEL_STATE_KEYS: Record<PanelState, string> = {
  healthy: K.panelState.healthy,
  degraded: K.panelState.degraded,
  maintenance: K.panelState.maintenance,
  down: K.panelState.down,
  throttled_or_blocked: K.panelState.throttled_or_blocked,
};

export const FAULT_KEYS: Record<ConnectionTestFault, string> = {
  timeout: K.fault.timeout,
  rate_limited: K.fault.rate_limited,
  blocked: K.fault.blocked,
  unavailable: K.fault.unavailable,
  unsupported: K.fault.unsupported,
  protocol: K.fault.protocol,
  unopenable: K.fault.unopenable,
  invalid_answers: K.fault.invalid_answers,
};

export const HOLD_REASON_KEYS: Record<HoldReason, string> = {
  gigawords_missing: K.holds.reason.gigawords_missing,
  session_never_closed: K.holds.reason.session_never_closed,
  publish_failed_after_read: K.holds.reason.publish_failed_after_read,
  attribution_ambiguous: K.holds.reason.attribution_ambiguous,
  panel_drift_event: K.holds.reason.panel_drift_event,
  low_trust_source: K.holds.reason.low_trust_source,
};

export const HOLD_STATE_KEYS: Record<SystemsHold["state"], string> = {
  pending: K.holds.state.pending,
  released: K.holds.state.released,
  written_off: K.holds.state.written_off,
};

export const DRIFT_EVENT_KEYS: Record<SystemsDriftEvent["eventType"], string> = {
  mass_reset: K.drift.type.mass_reset,
  mass_missing: K.drift.type.mass_missing,
  mass_rename: K.drift.type.mass_rename,
  mass_limit_override: K.drift.type.mass_limit_override,
  foreign_claim: K.drift.type.foreign_claim,
};

/**
 * The acceptance questionnaire, in `contracts/network/capabilities.json`'s
 * order. billing sends the key and the answer, never the question (billing
 * `contract.systems.md` rule 7): the page says both the question and the cost
 * of a `no` in the reader's language.
 */
export const CAPABILITY_KEYS = {
  per_client_usage: K.matrix.row.per_client_usage,
  bulk_usage_in_one_call: K.matrix.row.bulk_usage_in_one_call,
  usage_for_named_subset: K.matrix.row.usage_for_named_subset,
  usage_reset_supported: K.matrix.row.usage_reset_supported,
  counter_survives_client_update: K.matrix.row.counter_survives_client_update,
  gigawords_reported: K.matrix.row.gigawords_reported,
  per_client_data_limit: K.matrix.row.per_client_data_limit,
  data_limit_counts_the_same_bytes_as_usage: K.matrix.row.data_limit_counts_the_same_bytes_as_usage,
  per_client_rate_limit: K.matrix.row.per_client_rate_limit,
  enable_disable_client: K.matrix.row.enable_disable_client,
  client_lifecycle: K.matrix.row.client_lifecycle,
  stable_remote_id: K.matrix.row.stable_remote_id,
  client_label_storable: K.matrix.row.client_label_storable,
  native_subscription_link: K.matrix.row.native_subscription_link,
  server_side_expiry: K.matrix.row.server_side_expiry,
  internal_credit_disablable: K.matrix.row.internal_credit_disablable,
} as const;

/** The question and the cost of a `no` for one row; null for a key this page was not written against. */
export function capabilityText(key: string): { question: string; unmet: string } | null {
  return key in CAPABILITY_KEYS ? CAPABILITY_KEYS[key as keyof typeof CAPABILITY_KEYS] : null;
}

/** The refusals billing's systems routes name (`SystemsRejection`, `PanelScopeRejection`, `ResubmitRejection`, the vault's 502). */
export type SystemsRefusal =
  | "not_found"
  | "already_acknowledged"
  | "already_resolved"
  | "not_platform_owner"
  | "panel_refused"
  | "panel_not_push"
  | "credentials_unavailable"
  // Panel groups (F-027-bx -> billing F-027-bw).
  | "panel_not_found"
  | "member_not_found"
  | "already_member"
  | "already_draining"
  | "member_has_configs"
  // A panel's inbounds (F-114-b).
  | "inbound_not_found"
  | "inbound_not_sellable"
  // A panel's settings, deleting it, deleting a group (F-027-by/bz/ca).
  | "not_for_transport"
  | "panel_in_group"
  | "panel_has_configs"
  | "panel_retired"
  | "panel_not_retired"
  | "group_has_members"
  | "group_in_use";

export const REFUSAL_KEYS: Record<SystemsRefusal, string> = {
  not_found: K.refusals.not_found,
  already_acknowledged: K.refusals.already_acknowledged,
  already_resolved: K.refusals.already_resolved,
  not_platform_owner: K.refusals.not_platform_owner,
  panel_refused: K.refusals.panel_refused,
  panel_not_push: K.refusals.panel_not_push,
  credentials_unavailable: K.refusals.credentials_unavailable,
  panel_not_found: K.refusals.panel_not_found,
  member_not_found: K.refusals.member_not_found,
  already_member: K.refusals.already_member,
  already_draining: K.refusals.already_draining,
  member_has_configs: K.refusals.member_has_configs,
  inbound_not_found: K.refusals.inbound_not_found,
  inbound_not_sellable: K.refusals.inbound_not_sellable,
  not_for_transport: K.refusals.not_for_transport,
  panel_in_group: K.refusals.panel_in_group,
  panel_has_configs: K.refusals.panel_has_configs,
  panel_retired: K.refusals.panel_retired,
  panel_not_retired: K.refusals.panel_not_retired,
  group_has_members: K.refusals.group_has_members,
  group_in_use: K.refusals.group_in_use,
};

/** The refusal's own sentence key, when billing named one this page knows; else the generic message applies. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as SystemsRefusal] : null;
}

// ── Registering ───────────────────────────────────────────────────────────────

export type RegisterForm = {
  name: string;
  ipAddress: string;
  apiBaseUrl: string;
  /** Where users are served their links — Hiddify's client proxy path (F-027-bg). Optional; pull only. */
  clientBaseUrl: string;
  driverType: (typeof DRIVER_TYPES)[number];
  counterSemantics: (typeof COUNTER_SEMANTICS)[number];
  transport: (typeof PANEL_TRANSPORTS)[number];
  role: (typeof PANEL_ROLES)[number];
  region: string;
  /** Blank sends none, and billing keeps the column's default of 60. */
  maxRequestsPerMinute: string;
  credentials: string;
  /** A push panel's RADIUS secret (F-027-az). Sent only for a push panel. */
  radiusSecret: string;
};

export function emptyRegisterForm(): RegisterForm {
  return {
    name: "",
    ipAddress: "",
    apiBaseUrl: "",
    clientBaseUrl: "",
    driverType: "marzban",
    counterSemantics: "cumulative",
    transport: "pull",
    role: "active",
    region: "",
    maxRequestsPerMinute: "",
    credentials: "",
    radiusSecret: "",
  };
}

export type RegisterValidation =
  | { ok: true; body: RegisterPanelBody }
  | { ok: false; errors: Partial<Record<keyof RegisterForm, string>> };

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIp(value: string): boolean {
  if (IPV4.test(value)) return true;
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export function isUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * billing's `registerPanelSchema`, mirrored so a refusal is caught before the
 * call. The login is sent exactly as typed — a password may start or end with
 * a space — and is the one field not trimmed.
 */
export function validateRegister(form: RegisterForm): RegisterValidation {
  const errors: Partial<Record<keyof RegisterForm, string>> = {};
  const name = form.name.trim();
  const ipAddress = form.ipAddress.trim();
  const apiBaseUrl = form.apiBaseUrl.trim();
  const clientBaseUrl = form.clientBaseUrl.trim();
  const region = form.region.trim();
  const budget = form.maxRequestsPerMinute.trim();

  if (name.length < 1 || name.length > 100) errors.name = K.register.invalid.name;
  if (apiBaseUrl ? apiBaseUrl.length > 500 || !isUrl(apiBaseUrl) : form.transport === "pull") {
    errors.apiBaseUrl = K.register.invalid.apiBaseUrl;
  }
  const push = form.transport === "push";
  // Only a push panel's IP is ever read — its NAS's allowlist entry (F-027-br).
  if (push && !isIp(ipAddress)) errors.ipAddress = K.register.invalid.ipAddress;
  if (!push && clientBaseUrl && (clientBaseUrl.length > 500 || !isUrl(clientBaseUrl))) {
    errors.clientBaseUrl = K.register.invalid.clientBaseUrl;
  }
  if (region.length < 1 || region.length > 50) errors.region = K.register.invalid.region;
  const perMinute = budget === "" ? undefined : Number(budget);
  if (perMinute !== undefined && !(Number.isInteger(perMinute) && perMinute >= 1 && perMinute <= 6000)) {
    errors.maxRequestsPerMinute = K.register.invalid.maxRequestsPerMinute;
  }
  if (form.credentials.length < 1 || form.credentials.length > 4096) errors.credentials = K.register.invalid.credentials;
  if (push && (form.radiusSecret.length < 1 || form.radiusSecret.length > 4096)) errors.radiusSecret = K.register.invalid.radiusSecret;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const body: RegisterPanelBody = {
    name,
    // Never for a pull panel, even if typed before switching: nothing reads it there.
    ...(push ? { ipAddress } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    // Never for a push panel, even if typed before switching: billing refuses it there.
    ...(clientBaseUrl && !push ? { clientBaseUrl } : {}),
    driverType: form.driverType,
    counterSemantics: form.counterSemantics,
    transport: form.transport,
    role: form.role,
    region,
    ...(perMinute !== undefined ? { maxRequestsPerMinute: perMinute } : {}),
    credentials: form.credentials,
    // Never for a pull panel, even if typed before switching: billing refuses it there.
    ...(push ? { radiusSecret: form.radiusSecret } : {}),
  };
  return { ok: true, body };
}

// ── Reading a panel ───────────────────────────────────────────────────────────

/**
 * What the connection test has said about a panel — only ever what
 * `network-service` wrote. A fault is the test getting no answer, not a
 * verdict: the panel stays `pending` and is tested again (ADR-0080).
 */
export function verdictOf(panel: SystemsPanel): { state: PanelReviewState; fault: ConnectionTestFault | null } {
  const { reviewState, connectionTestFault } = panel.review;
  return { state: reviewState, fault: reviewState === "pending" ? connectionTestFault : null };
}

/**
 * Why a panel was refused at registration, read off its matrix: the `required`
 * rows it answered `no`. The unmet `metered` rows are said apart — the panel
 * is accepted, but may not sell metered service (ADR-0072). This is where a
 * panel is refused, never at billing time.
 */
export function refusedBecause(rows: readonly CapabilityRow[]): { refused: string[]; noMeteredSale: string[] } {
  const unmet = (severity: string) => rows.filter((r) => r.severity === severity && r.state === "unsupported").map((r) => r.key);
  return { refused: unmet("required"), noMeteredSale: unmet("metered") };
}

// ── A new login (F-027-au) ────────────────────────────────────────────────────

/** Every panel but a refused one: it was refused on its answers, and billing answers 409 `panel_refused`. */
export function canResubmit(panel: SystemsPanel): boolean {
  return panel.review.reviewState !== "refused";
}

/** The login alone, as at registration: 1–4096 and not trimmed. */
export function validateLogin(input: string): { ok: true; credentials: string } | { ok: false; error: string } {
  return input.length >= 1 && input.length <= 4096
    ? { ok: true, credentials: input }
    : { ok: false, error: K.register.invalid.credentials };
}

/**
 * What the answer means, in one sentence: a `pending` panel is re-tested on
 * the next tick, or — no `retest` — is cooling off after `rate_limited` (or
 * got its verdict meanwhile, which the list then shows); an accepted one keeps
 * collecting and uses the new login from its next pass.
 */
export function resubmitOutcome(answer: ResubmittedLogin): string {
  if (answer.reviewState !== "pending") return K.resubmit.outcome.rotated;
  return answer.retest ? K.resubmit.outcome.retest : K.resubmit.outcome.coolingOff;
}

// ── A push panel's RADIUS secret (F-027-az) ──────────────────────────────────

/** A push panel that is not refused: a pull panel has no NAS (409 `panel_not_push`). */
export function canResubmitRadiusSecret(panel: SystemsPanel): boolean {
  return panel.transport === "push" && panel.review.reviewState !== "refused";
}

/** A push panel with no secret stored: its NAS is kept off the allowlist and every packet from it is dropped. */
export function radiusSecretMissing(panel: SystemsPanel): boolean {
  return panel.transport === "push" && panel.radiusSecretConfigured === false;
}

/** The secret alone: 1–4096 and not trimmed, as the login. */
export function validateRadiusSecret(input: string): { ok: true; radiusSecret: string } | { ok: false; error: string } {
  return input.length >= 1 && input.length <= 4096
    ? { ok: true, radiusSecret: input }
    : { ok: false, error: K.register.invalid.radiusSecret };
}

// ── Drift and holds ───────────────────────────────────────────────────────────

/** The collector's own test (`collect.Containment.Halted`, billing rule 8) — the page cannot disagree with the loop. */
export function haltsCollection(event: SystemsDriftEvent): boolean {
  return event.collectionHalted && event.acknowledgedAt === null;
}

/** Acknowledging happens once; who decided is never rewritten (billing rule 9). */
export function canAcknowledge(event: SystemsDriftEvent): boolean {
  return event.acknowledgedAt === null;
}

/** Release and write-off end a `pending` hold; a decided one is 409 `already_resolved`. */
export function canResolveHold(hold: SystemsHold): boolean {
  return hold.state === "pending";
}

/**
 * The note on an acknowledge, a release or a write-off: 1–1000 trimmed.
 * A write-off requires it — bytes that are never charged say why (ADR-0080
 * decision 3); the other two send none when it is left blank.
 */
export function validateNote(
  input: string,
  { required }: { required: boolean },
): { ok: true; note: string | undefined } | { ok: false; error: string } {
  const note = input.trim();
  if (note.length > 1000) return { ok: false, error: K.note.tooLong };
  if (note.length === 0) return required ? { ok: false, error: K.note.required } : { ok: true, note: undefined };
  return { ok: true, note };
}
