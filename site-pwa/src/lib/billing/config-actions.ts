// What a config is and what an action on one answers — its drift verdicts, its
// statuses, the refusals billing names (F-027-ac). Split from `grants.ts` by job.

/**
 * The convergence loop's verdicts on a config (F-027-aa/ab), as `network.prisma`
 * declares `DriftState` (C-09). Only `synced` is quiet: every other one is a
 * button on the service page that says why (F-027-ac).
 */
export const DRIFT_STATES = [
  "synced",
  "reset",
  "renamed",
  "rebuilt",
  "missing",
  "orphan",
  "limit_overridden",
  "contested",
] as const;

export type DriftState = (typeof DRIFT_STATES)[number];

/** A config's own status, as `network.prisma` declares `ConfigStatus`, minus `retired` — the list never answers one. */
export const CONFIG_STATUSES = ["active", "frozen", "disabled_by_admin", "disabled_by_system"] as const;

export type ConfigStatus = (typeof CONFIG_STATUSES)[number];

/** The one action a user may take on a config: a new link. No delete (F-027-ac1). */
export type ConfigAction = "regenerate";

/**
 * Why one config's action wrote nothing: billing's `CONFIG_ACTION_REJECTIONS`
 * (`traffic/config-actions.ts`) plus `failed` for a throw that was not a
 * refusal. The page has a sentence for each; the spec reads the tuple.
 */
export const CONFIG_ACTION_REFUSALS = [
  "grant_not_found",
  "grant_not_active",
  "panel_not_found",
  "config_not_found",
  "config_retired",
  "regenerate_limit_reached",
  "regenerate_unfunded",
  "config_changed",
  "same_panel",
  "no_placement_on_target",
  "config_leaving",
  "actor_not_allowed",
  "failed",
] as const;

export type ConfigActionRefusal = (typeof CONFIG_ACTION_REFUSALS)[number];

export type ConfigActionOutcome =
  | { configId: string; ok: true }
  | { configId: string; ok: false; reason: ConfigActionRefusal };
