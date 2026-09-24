import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type {
  CapabilityRow,
  ConnectionTestFault,
  HoldReason,
  PanelReviewState,
  PanelState,
  RegisterPanelBody,
  SystemsDriftEvent,
  SystemsHold,
  SystemsPanel,
} from "@/lib/billing-api";

/** Every string the systems page can show (C-06). */
export const SYSTEMS_KEYS = FrontendI18nKeys.common.systems;
const K = SYSTEMS_KEYS;

/** billing's `PANEL_MANAGE` — the menu entry needs it (F-027-ar). */
export const PANEL_MANAGE = "panel.manage";

// The closed sets the register form offers, as `network.prisma` declares them
// (C-09). `systems.test.ts` reads each enum out of the schema.
export const DRIVER_TYPES = [
  "marzban",
  "marzneshin",
  "sanaee",
  "x_ui",
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

/** The refusals billing's systems routes name (`SystemsRejection`, `PanelScopeRejection`, the vault's 502). */
export type SystemsRefusal = "not_found" | "already_acknowledged" | "already_resolved" | "not_platform_owner" | "credentials_unavailable";

export const REFUSAL_KEYS: Record<SystemsRefusal, string> = {
  not_found: K.refusals.not_found,
  already_acknowledged: K.refusals.already_acknowledged,
  already_resolved: K.refusals.already_resolved,
  not_platform_owner: K.refusals.not_platform_owner,
  credentials_unavailable: K.refusals.credentials_unavailable,
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
  driverType: (typeof DRIVER_TYPES)[number];
  counterSemantics: (typeof COUNTER_SEMANTICS)[number];
  transport: (typeof PANEL_TRANSPORTS)[number];
  role: (typeof PANEL_ROLES)[number];
  region: string;
  /** Blank sends none, and billing keeps the column's default of 60. */
  maxRequestsPerMinute: string;
  credentials: string;
};

export function emptyRegisterForm(): RegisterForm {
  return {
    name: "",
    ipAddress: "",
    apiBaseUrl: "",
    driverType: "marzban",
    counterSemantics: "cumulative",
    transport: "pull",
    role: "active",
    region: "",
    maxRequestsPerMinute: "",
    credentials: "",
  };
}

export type RegisterValidation =
  | { ok: true; body: RegisterPanelBody }
  | { ok: false; errors: Partial<Record<keyof RegisterForm, string>> };

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIp(value: string): boolean {
  if (IPV4.test(value)) return true;
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

function isUrl(value: string): boolean {
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
  const region = form.region.trim();
  const budget = form.maxRequestsPerMinute.trim();

  if (name.length < 1 || name.length > 100) errors.name = K.register.invalid.name;
  if (!isIp(ipAddress)) errors.ipAddress = K.register.invalid.ipAddress;
  if (apiBaseUrl ? apiBaseUrl.length > 500 || !isUrl(apiBaseUrl) : form.transport === "pull") {
    errors.apiBaseUrl = K.register.invalid.apiBaseUrl;
  }
  if (region.length < 1 || region.length > 50) errors.region = K.register.invalid.region;
  const perMinute = budget === "" ? undefined : Number(budget);
  if (perMinute !== undefined && !(Number.isInteger(perMinute) && perMinute >= 1 && perMinute <= 6000)) {
    errors.maxRequestsPerMinute = K.register.invalid.maxRequestsPerMinute;
  }
  if (form.credentials.length < 1 || form.credentials.length > 4096) errors.credentials = K.register.invalid.credentials;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const body: RegisterPanelBody = {
    name,
    ipAddress,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    driverType: form.driverType,
    counterSemantics: form.counterSemantics,
    transport: form.transport,
    role: form.role,
    region,
    ...(perMinute !== undefined ? { maxRequestsPerMinute: perMinute } : {}),
    credentials: form.credentials,
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
