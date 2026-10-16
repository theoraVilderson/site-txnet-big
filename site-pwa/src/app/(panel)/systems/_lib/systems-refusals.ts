import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The systems page's words — `SYSTEMS_KEYS`, read here directly: `systems.ts` imports this file. */
const K = FrontendI18nKeys.common.systems;

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
  | "no_other_member"
  | "member_has_configs"
  // A panel's inbounds (F-114-b).
  | "inbound_not_found"
  | "inbound_not_sellable"
  // A panel's settings, deleting it, deleting a group (F-027-by/bz/ca).
  | "not_for_transport"
  | "panel_already_registered"
  | "not_for_driver"
  | "panel_in_group"
  | "panel_has_configs"
  | "panel_retired"
  | "panel_not_retired"
  | "group_has_members"
  | "group_in_use"
  // An inbound is the pool's or one group's (F-027-ch).
  | "inbound_assigned_elsewhere"
  | "inbound_has_configs"
  // A panel's monthly cost never lands in a closed month (F-1002-a).
  | "cost_in_closed_month"
  | "resolution_required"
  | "resolution_not_for_event";

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
  no_other_member: K.refusals.no_other_member,
  member_has_configs: K.refusals.member_has_configs,
  inbound_not_found: K.refusals.inbound_not_found,
  inbound_not_sellable: K.refusals.inbound_not_sellable,
  not_for_transport: K.refusals.not_for_transport,
  panel_already_registered: K.refusals.panel_already_registered,
  not_for_driver: K.refusals.not_for_driver,
  panel_in_group: K.refusals.panel_in_group,
  panel_has_configs: K.refusals.panel_has_configs,
  panel_retired: K.refusals.panel_retired,
  panel_not_retired: K.refusals.panel_not_retired,
  group_has_members: K.refusals.group_has_members,
  group_in_use: K.refusals.group_in_use,
  inbound_assigned_elsewhere: K.refusals.inbound_assigned_elsewhere,
  inbound_has_configs: K.refusals.inbound_has_configs,
  cost_in_closed_month: K.refusals.cost_in_closed_month,
  resolution_required: K.refusals.resolution_required,
  resolution_not_for_event: K.refusals.resolution_not_for_event,
};

/** The refusal's own sentence key, when billing named one this page knows; else the generic message applies. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as SystemsRefusal] : null;
}
