import type { PanelGroup, PanelSettingsBody, RemovedPanel, SystemsPanel } from "@/lib/billing-api";
import { SYSTEMS_KEYS, isIp, isUrl, validateLogin } from "./systems";

/**
 * A registered panel's life on the systems page (F-027-cb): editing its
 * settings, deleting or archiving it, restoring it, and deleting a group.
 * The routes and every rule are billing's (`contract.panel-lifecycle.md`,
 * `contract.systems.md` rule 24a); this mirrors them so a refusal is said
 * before the call, and says what the answer means.
 */
const K = SYSTEMS_KEYS;

// ── Editing a panel ───────────────────────────────────────────────────────────

/** Every setting as typed. The login is blank unless the admin types a new one. */
export type PanelEditForm = {
  name: string;
  region: string;
  ipAddress: string;
  apiBaseUrl: string;
  clientBaseUrl: string;
  maxRequestsPerMinute: string;
  credentials: string;
};

export function panelEditFormOf(panel: SystemsPanel): PanelEditForm {
  return {
    name: panel.name,
    region: panel.region,
    ipAddress: panel.ipAddress ?? "",
    apiBaseUrl: panel.apiBaseUrl ?? "",
    clientBaseUrl: panel.clientBaseUrl ?? "",
    maxRequestsPerMinute: String(panel.budget.maxRequestsPerMinute),
    credentials: "",
  };
}

export type PanelEditValidation =
  | { ok: true; body: PanelSettingsBody; credentials: string | null }
  | { ok: false; errors: Partial<Record<keyof PanelEditForm | "form", string>> };

/**
 * billing's `updatePanelSchema`, sending **only what differs** from the panel:
 * a field nobody touched is never re-sent, so an address that did not change
 * never re-tests the panel. A push panel is never asked for an API or link
 * address and cannot clear its IP (`not_for_transport`); a pull panel's IP is
 * optional. A new login goes to its own route; blank keeps the stored one.
 */
export function validatePanelEdit(form: PanelEditForm, panel: SystemsPanel): PanelEditValidation {
  const errors: Partial<Record<keyof PanelEditForm | "form", string>> = {};
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
  if (form.credentials !== "") {
    const login = validateLogin(form.credentials);
    if (login.ok) credentials = login.credentials;
    else errors.credentials = login.error;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const body: PanelSettingsBody = {};
  if (name !== panel.name) body.name = name;
  if (region !== panel.region) body.region = region;
  if ((ipAddress || null) !== panel.ipAddress) body.ipAddress = ipAddress || null;
  if (!push && apiBaseUrl !== (panel.apiBaseUrl ?? "")) body.apiBaseUrl = apiBaseUrl;
  if (!push && (clientBaseUrl || null) !== panel.clientBaseUrl) body.clientBaseUrl = clientBaseUrl || null;
  if (budget !== panel.budget.maxRequestsPerMinute) body.maxRequestsPerMinute = budget;
  if (Object.keys(body).length === 0 && credentials === null) return { ok: false, errors: { form: K.edit.unchanged } };
  return { ok: true, body, credentials };
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
};

/** Why a group cannot be deleted yet (rule 24a), with the count to say; null when it can. */
export function groupDeleteBlock(group: PanelGroup): { key: string; n: number } | null {
  if (group.members.length > 0) return { key: K.groupsRemove.blockedMembers, n: group.members.length };
  if (group.variantCount > 0) return { key: K.groupsRemove.blockedVariants, n: group.variantCount };
  return null;
}
