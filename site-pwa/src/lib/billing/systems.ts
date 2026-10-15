// The platform owner's systems page: panels, capabilities, drift and holds (F-027-ad).
import { type CursorPage, call } from "./client";
import type { EvictOrphans, EvictPreview } from "./panel-groups";

// ── The systems page (F-027-ad) — billing `contract.systems.md` ──────────────
// Every value below is what `network-service`'s loops last wrote (ADR-0071):
// billing reads columns, it never calls the Go service, so a stale figure
// shows as an old timestamp, never as a number made up on the way.

/** `network.PanelReviewState`. A verdict arrives on the next tick; until then `pending`. */
export type PanelReviewState = "pending" | "accepted" | "accepted_low_trust" | "refused";

/** `network.PanelState`. `throttled_or_blocked` is a panel answering and refusing us, not one that is down. */
export type PanelState = "healthy" | "degraded" | "maintenance" | "down" | "throttled_or_blocked";

/** `network.PanelFaultCause` (ADR-0122): why a panel is not healthy, with what to fix. */
export type PanelFaultCause =
  | "dns_failed"
  | "connection_refused"
  | "unreachable"
  | "unresponsive"
  | "tls_failed"
  | "not_found"
  | "server_error"
  | "login_refused"
  | "forbidden"
  | "rate_limited"
  | "bad_answer";

/** Why a panel's state is on hold — the outage is ours (billing `systems/panel-health.ts`). */
export type PanelHeldReason = "collector_stopped" | "collector_never_ran" | "egress_down" | "egress_suspect" | "dns_down";

/** `network.ConnectionTestFault`: the test did not get an answer — not a verdict. */
export type ConnectionTestFault =
  | "timeout"
  | "rate_limited"
  | "blocked"
  | "unavailable"
  | "unsupported"
  | "protocol"
  | "unopenable"
  | "invalid_answers";

export interface SystemsPanel {
  id: string;
  name: string;
  driverType: string;
  transport: "pull" | "push";
  role: "active" | "passive";
  region: string;
  /** Where it is reached (F-027-by): what the edit form starts from. */
  ipAddress: string | null;
  apiBaseUrl: string | null;
  clientBaseUrl: string | null;
  /** The CDN opt-out (F-027-fa): dialed wherever its name resolves, never halted `address_moved`. */
  addressMayMove: boolean;
  /** Archived (F-027-bz): kept for its records, skipped by every loop. Null for a panel in service. */
  retiredAt: string | null;
  /** Deleted in one step while in groups (F-027-eg): leaving them, archived once empty. */
  removeRequestedAt: string | null;
  /** Whether a push panel's RADIUS secret is stored (F-027-az); null on a pull panel. */
  radiusSecretConfigured: boolean | null;
  review: {
    reviewState: PanelReviewState;
    connectionTestedAt: string | null;
    connectionTestFault: ConnectionTestFault | null;
    connectionTestDetail: string | null;
    /** A refused duplicate's holder (F-027-ce); null when none, or when it is outside the reader's scope (F-027-cj). */
    duplicateOf: { id: string; name: string } | null;
  };
  health: {
    panelState: PanelState;
    /** Why it is not healthy; null while it is (F-027-ej). */
    cause: PanelFaultCause | null;
    /** When it entered panelState — the start of the trouble. */
    since: string | null;
    /** The last turn the collector judged it on. */
    checkedAt: string | null;
    /** Whether panelState is current, on hold because the outage is ours, or not being checked (F-027-em). */
    view: "current" | "on_hold" | "not_checked";
    heldBy: { reason: PanelHeldReason; since: string | null } | null;
    lastHealthyAt: string | null;
    lastSuccessfulCollectionAt: string | null;
    collectionHalted: boolean;
    openDriftEvents: number;
  };
  budget: { maxRequestsPerMinute: number; blockedSince: string | null };
}

/** One questionnaire row as billing answers it (`systems/capabilities.ts`). The question is said here, by `key`. */
export interface CapabilityRow {
  key: string;
  scope: string;
  severity: string;
  state: string;
  detail: string | null;
}

export interface CapabilityMatrix {
  id: string;
  transport: string;
  reviewState: PanelReviewState;
  connectionTestedAt: string | null;
  documentVersion: number | null;
  /** False when the stored answers are under another version: every row in scope reads `unanswered`. */
  current: boolean;
  answeredAt: string | null;
  rows: CapabilityRow[];
}

export interface SystemsDriftEvent {
  id: string;
  panelId: string;
  panelName: string | null;
  eventType: "mass_reset" | "mass_missing" | "mass_rename" | "mass_limit_override" | "foreign_claim" | "identity_lost" | "address_moved";
  /** The panel whose users a `foreign_claim` found; null otherwise, or when it is outside your panels. */
  foreignPanel: { id: string; name: string } | null;
  affectedConfigCount: number;
  observedConfigCount: number;
  detectedAt: string;
  collectionHalted: boolean;
  acknowledgedAt: string | null;
  acknowledgedByAdminId: string | null;
  note: string | null;
  /** An `address_moved`'s addresses (F-027-ez): accepted at, and seen instead. Empty or null on any other type. */
  knownAddresses: string[] | null;
  seenAddresses: string[] | null;
}

/** What an `identity_lost` server is (billing `DRIFT_RESOLUTIONS`, rule 9b). */
export type DriftResolution = "rebuilt" | "address_fixed";

/** billing `acknowledgeDriftSchema`: a `resolution` only on `identity_lost`, where it is required. */
export type AcknowledgeDriftBody = { note?: string; resolution?: DriftResolution };

export type HoldReason =
  | "gigawords_missing"
  | "session_never_closed"
  | "publish_failed_after_read"
  | "attribution_ambiguous"
  | "panel_drift_event"
  | "low_trust_source";

export interface SystemsHold {
  id: string;
  configId: string;
  panelId: string;
  panelName: string | null;
  /** Decimal strings: a BIGINT past 2^53 is not a JSON number (rule 13). */
  upBytes: string;
  downBytes: string;
  reason: HoldReason;
  state: "pending" | "released" | "written_off";
  heldFrom: string;
  heldAt: string;
  resolvedAt: string | null;
  resolvedByAdminId: string | null;
  resolutionNote: string | null;
}

/** billing `updatePanelSchema` (F-027-by): any of these, at least one. `apiBaseUrl` is never cleared. */
export type PanelSettingsBody = Partial<{
  name: string;
  region: string;
  ipAddress: string | null;
  apiBaseUrl: string;
  clientBaseUrl: string | null;
  maxRequestsPerMinute: number;
  addressMayMove: boolean;
}>;

export type UpdatedPanel = { id: string; reviewState: PanelReviewState; retest: boolean };

export type RemovedPanel = { id: string; outcome: "deleted" | "archived" | "removing"; groups?: number };

export type PanelRemovePreview = EvictPreview & { groups: number };

/** What re-submitting a login answers (F-027-au). `retest`: the next tick tests the panel again. */
export interface ResubmittedLogin {
  id: string;
  reviewState: PanelReviewState;
  retest: boolean;
  credentials: RegisteredPanel["credentials"];
}

/** What re-submitting a push panel's RADIUS secret answers (F-027-az). Nothing is re-tested. */
export interface ResubmittedRadiusSecret {
  id: string;
  reviewState: PanelReviewState;
  radiusSecret: RegisteredPanel["credentials"];
}

/** What a release answers: queued for the meter, the hold still `pending` (rule 10). */
export interface QueuedRelease {
  id: string;
  state: "pending";
  release: "queued";
}

export interface RegisterPanelBody {
  name: string;
  /** A push panel's NAS address, its allowlist entry: required there, never sent for a pull panel (F-027-br). */
  ipAddress?: string;
  apiBaseUrl?: string;
  /** Where users are served their links — Hiddify's client proxy path (F-027-bg). Refused on a push panel. */
  clientBaseUrl?: string;
  driverType: string;
  counterSemantics: string;
  transport: "pull" | "push";
  role: "active" | "passive";
  region: string;
  maxRequestsPerMinute?: number;
  /** The panel's login. Relayed once to the vault and never answered back. */
  credentials: string;
  /** A push panel's RADIUS shared secret (F-027-az): required there, refused on a pull panel. */
  radiusSecret?: string;
}

export interface RegisteredPanel {
  id: string;
  reviewState: "pending";
  credentials: { configured: boolean; version: number | null; rotatedAt: string | null };
  /** Present for a push panel only (F-027-az). */
  radiusSecret?: { configured: boolean; version: number | null; rotatedAt: string | null };
}

/** The systems page's panel calls — spread into `billingApi` (`lib/billing-api.ts`). */
export const systemsCalls = {
  // The systems page (F-027-ad). billing scopes every one to the platform
  // owner's panels (`panelScopeOf`); nothing here sends a tenant.

  /** Register a panel as desired state. The answer is always `pending`: the verdict is the next tick's. */
  async registerPanel(body: RegisterPanelBody): Promise<RegisteredPanel> {
    return call<RegisteredPanel>("/systems/panels", { method: "POST", body: JSON.stringify(body) });
  },

  /**
   * A new login for a registered panel (F-027-au): rotated in the vault; a
   * `pending` panel is re-tested on the next tick unless it is cooling off
   * after `rate_limited`. A refused panel is 409 `panel_refused`.
   */
  async resubmitPanelLogin(id: string, credentials: string): Promise<ResubmittedLogin> {
    return call<ResubmittedLogin>(`/systems/panels/${encodeURIComponent(id)}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ credentials }),
    });
  },

  /**
   * A new RADIUS secret for a push panel (F-027-az): rotated in the vault; the
   * allowlist reads it within a minute and nothing is re-tested. A pull panel
   * is 409 `panel_not_push`, a refused one 409 `panel_refused`.
   */
  async resubmitPanelRadiusSecret(id: string, radiusSecret: string): Promise<ResubmittedRadiusSecret> {
    return call<ResubmittedRadiusSecret>(`/systems/panels/${encodeURIComponent(id)}/radius-secret`, {
      method: "PUT",
      body: JSON.stringify({ radiusSecret }),
    });
  },

  /**
   * A panel's settings (F-027-by): only what changed. A changed API or link
   * address sends it back to `pending` (`retest`); a push panel takes neither
   * (409 `not_for_transport`), an archived one nothing (409 `panel_retired`).
   */
  async updatePanel(id: string, body: PanelSettingsBody): Promise<UpdatedPanel> {
    return call<UpdatedPanel>(`/systems/panels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  /**
   * Delete a panel (F-027-bz): `deleted` with no history, `archived` with it.
   * 409 `panel_in_group` / `panel_has_configs` while it serves — unless
   * `orphans` is given (F-027-eg): then a panel in groups is evicted from all
   * of them with that choice and answered `removing`.
   */
  async deletePanel(id: string, orphans?: EvictOrphans): Promise<RemovedPanel> {
    const query = orphans ? `?orphans=${orphans}` : "";
    return call<RemovedPanel>(`/systems/panels/${encodeURIComponent(id)}${query}`, { method: "DELETE" });
  },

  /** What deleting it in one step takes, summed over its groups (F-027-eg). */
  async panelRemovePreview(id: string): Promise<PanelRemovePreview> {
    return call<PanelRemovePreview>(`/systems/panels/${encodeURIComponent(id)}/remove-preview`);
  },

  /** Restore an archived panel (F-027-bz): back to `pending`, tested before it is collected. */
  async restorePanel(id: string): Promise<{ id: string; reviewState: "pending" }> {
    return call<{ id: string; reviewState: "pending" }>(`/systems/panels/${encodeURIComponent(id)}/restore`, { method: "POST" });
  },

  async systemsPanels(): Promise<SystemsPanel[]> {
    return call<SystemsPanel[]>("/systems/panels", { method: "GET" });
  },

  async panelCapabilities(id: string): Promise<CapabilityMatrix> {
    return call<CapabilityMatrix>(`/systems/panels/${encodeURIComponent(id)}/capabilities`, { method: "GET" });
  },

  async driftEvents(query: { state: "open" | "all"; after?: string }): Promise<CursorPage<SystemsDriftEvent>> {
    const q = new URLSearchParams({ state: query.state });
    if (query.after) q.set("after", query.after);
    return call<CursorPage<SystemsDriftEvent>>(`/systems/drift-events?${q}`, { method: "GET" });
  },

  /** The decision a halted panel waits for; its collection resumes on the next pass. */
  async acknowledgeDrift(id: string, body: AcknowledgeDriftBody): Promise<SystemsDriftEvent> {
    return call<SystemsDriftEvent>(`/systems/drift-events/${encodeURIComponent(id)}/acknowledge`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  async usageHolds(query: { state: "pending" | "all"; after?: string }): Promise<CursorPage<SystemsHold>> {
    const q = new URLSearchParams({ state: query.state });
    if (query.after) q.set("after", query.after);
    return call<CursorPage<SystemsHold>>(`/systems/holds?${q}`, { method: "GET" });
  },

  /** Queued for the meter (202); the hold stays `pending` until it is billed. A second release is harmless. */
  async releaseHold(id: string, note?: string): Promise<QueuedRelease> {
    return call<QueuedRelease>(`/systems/holds/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: JSON.stringify(note === undefined ? {} : { note }),
    });
  },

  /** Never charged, and once: a second write-off is 409 `already_resolved`. */
  async writeOffHold(id: string, note: string): Promise<SystemsHold> {
    return call<SystemsHold>(`/systems/holds/${encodeURIComponent(id)}/write-off`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
  },
};
