import type { PanelGroup, PanelSettingsBody, RemovedPanel, SystemsPanel } from "@/lib/billing-api";
import { SYSTEMS_KEYS, isIp, isUrl, validateLogin } from "./systems";
import { composeLogin, loginErrors, loginKindOf, type LoginParts } from "./register-wizard";

/**
 * A registered panel's life on the systems page (F-027-cb): editing its
 * settings, deleting or archiving it, restoring it, and deleting a group.
 * The routes and every rule are billing's (`contract.panel-lifecycle.md`,
 * `contract.systems.md` rule 24a); this mirrors them so a refusal is said
 * before the call, and says what the answer means.
 */
const K = SYSTEMS_KEYS;

// ── Editing a panel ───────────────────────────────────────────────────────────

/**
 * Every setting as typed. The login is blank unless the admin types a new one,
 * and is asked in its parts as the register wizard asks it: a username and a
 * password, or the API key for a family that logs in with one.
 */
export type PanelEditForm = {
  name: string;
  region: string;
  ipAddress: string;
  apiBaseUrl: string;
  clientBaseUrl: string;
  maxRequestsPerMinute: string;
  addressMayMove: boolean;
  username: string;
  password: string;
  apiKey: string;
};

export function panelEditFormOf(panel: SystemsPanel): PanelEditForm {
  return {
    name: panel.name,
    region: panel.region,
    ipAddress: panel.ipAddress ?? "",
    apiBaseUrl: panel.apiBaseUrl ?? "",
    clientBaseUrl: panel.clientBaseUrl ?? "",
    maxRequestsPerMinute: String(panel.budget.maxRequestsPerMinute),
    addressMayMove: panel.addressMayMove,
    username: "",
    password: "",
    apiKey: "",
  };
}

export type PanelEditValidation =
  | { ok: true; body: PanelSettingsBody; credentials: string | null }
  | { ok: false; errors: Partial<Record<keyof PanelEditForm | "credentials" | "form", string>> };

/**
 * billing's `updatePanelSchema`, sending **only what differs** from the panel:
 * a field nobody touched is never re-sent, so an address that did not change
 * never re-tests the panel. A push panel is never asked for an API or link
 * address and cannot clear its IP (`not_for_transport`); a pull panel's IP is
 * optional. A new login goes to its own route; blank keeps the stored one,
 * and a half-typed one names the missing half rather than sending a password
 * the collector would read as a username.
 */
export function validatePanelEdit(form: PanelEditForm, panel: SystemsPanel): PanelEditValidation {
  const errors: Partial<Record<keyof PanelEditForm | "credentials" | "form", string>> = {};
  const push = panel.transport === "push";
  const name = form.name.trim();
  const region = form.region.trim();
  const ipAddress = form.ipAddress.trim();
  const apiBaseUrl = form.apiBaseUrl.trim();
  const clientBaseUrl = form.clientBaseUrl.trim();
  const budget = Number(form.maxRequestsPerMinute.trim());

  if (name.length < 1 || name.length > 100) errors.name = K.register.invalid.name;
  if (region.length < 1 || region.length > 50) errors.region = K.register.invalid.region;
  if (push ? !isIp(ipAddress) : ipAddress !== "" && !isIp(ipAddress)) errors.ipAddress = K.register.invalid.ipAddress;
  if (!push && (apiBaseUrl.length > 500 || !isUrl(apiBaseUrl))) errors.apiBaseUrl = K.register.invalid.apiBaseUrl;
  if (!push && clientBaseUrl && (clientBaseUrl.length > 500 || !isUrl(clientBaseUrl))) errors.clientBaseUrl = K.register.invalid.clientBaseUrl;
  if (!(Number.isInteger(budget) && budget >= 1 && budget <= 6000)) errors.maxRequestsPerMinute = K.edit.invalidBudget;
  let credentials: string | null = null;
  const login = checkNewLogin(panel.driverType, form, false);
  if (login.ok) credentials = login.credentials;
  else Object.assign(errors, login.errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const body: PanelSettingsBody = {};
  if (name !== panel.name) body.name = name;
  if (region !== panel.region) body.region = region;
  if ((ipAddress || null) !== panel.ipAddress) body.ipAddress = ipAddress || null;
  if (!push && apiBaseUrl !== (panel.apiBaseUrl ?? "")) body.apiBaseUrl = apiBaseUrl;
  if (!push && (clientBaseUrl || null) !== panel.clientBaseUrl) body.clientBaseUrl = clientBaseUrl || null;
  if (budget !== panel.budget.maxRequestsPerMinute) body.maxRequestsPerMinute = budget;
  // A setting, not an address: it re-tests nothing (billing rule 5b).
  if (!push && form.addressMayMove !== panel.addressMayMove) body.addressMayMove = form.addressMayMove;
  if (Object.keys(body).length === 0 && credentials === null) return { ok: false, errors: { form: K.edit.unchanged } };
  return { ok: true, body, credentials };
}

export type NewLoginErrors = Partial<Record<keyof LoginParts | "credentials", string>>;

/**
 * A new login typed in its parts, composed the way the collector reads it:
 * `username:password`, or the API key alone (`loginKindOf`). Not required, a
 * blank one is `credentials: null` and keeps the stored login; a half-typed
 * one names the missing half rather than sending a password as the username.
 */
export function checkNewLogin(
  driverType: string,
  parts: LoginParts,
  required: boolean,
): { ok: true; credentials: string | null } | { ok: false; errors: NewLoginErrors } {
  const kind = loginKindOf(driverType);
  const typed = kind === "apiKey" ? parts.apiKey !== "" : parts.username !== "" || parts.password !== "";
  if (!typed && !required) return { ok: true, credentials: null };
  const missing = loginErrors(kind, parts) as NewLoginErrors;
  if (Object.keys(missing).length > 0) return { ok: false, errors: missing };
  const login = validateLogin(composeLogin(kind, parts));
  return login.ok ? { ok: true, credentials: login.credentials } : { ok: false, errors: { credentials: login.error } };
}

/** Whether saving this form re-tests the panel: billing's rule 2, said before the save. */
export function addressChanged(form: PanelEditForm, panel: SystemsPanel): boolean {
  if (panel.transport === "push") return false;
  return form.apiBaseUrl.trim() !== (panel.apiBaseUrl ?? "") || (form.clientBaseUrl.trim() || null) !== panel.clientBaseUrl;
}

// ── Deleting, archiving, restoring ────────────────────────────────────────────

export function isArchived(panel: SystemsPanel): boolean {
  return panel.retiredAt !== null;
}

/** The panels shown: archived ones only when asked for, in service first. */
export function visiblePanels(panels: readonly SystemsPanel[], showArchived: boolean): SystemsPanel[] {
  const live = panels.filter((p) => !isArchived(p));
  return showArchived ? [...live, ...panels.filter(isArchived)] : live;
}

/**
 * The groups holding a panel: billing refuses the delete while there is one
 * (`panel_in_group`), so the confirm names them instead of offering a button
 * that can only be refused. A live config without a group is billing's to say.
 */
export function groupsHolding(panel: SystemsPanel, groups: readonly PanelGroup[]): string[] {
  return groups.filter((g) => g.members.some((m) => m.panelId === panel.id)).map((g) => g.name);
}

export const DELETE_OUTCOME_KEYS: Record<RemovedPanel["outcome"], string> = {
  deleted: K.remove.deleted,
  archived: K.remove.archived,
  removing: K.remove.removing,
};

/** Deleted in one step while in groups (F-027-eg): leaving them now, archived by the sweep once empty — still listed meanwhile. */
export function isRemoving(panel: SystemsPanel): boolean {
  return panel.removeRequestedAt != null;
}

/** Why a group cannot be deleted yet (rule 24a), with the count to say; null when it can. */
export function groupDeleteBlock(group: PanelGroup): { key: string; n: number } | null {
  if (group.members.length > 0) return { key: K.groupsRemove.blockedMembers, n: group.members.length };
  if (group.variantCount > 0) return { key: K.groupsRemove.blockedVariants, n: group.variantCount };
  return null;
}
