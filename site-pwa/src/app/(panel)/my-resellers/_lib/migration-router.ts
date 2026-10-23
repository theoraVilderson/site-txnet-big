import type { MigrationRun, PanelReviewState, RegisterRouterBody, ResellerRouter } from "@/lib/billing-api";
import { RealtimeEvents } from "@/generated/wire";
import { tenantChannelOf } from "@/lib/tenant-channel";
import type { Tone } from "../../_components/kit";
import { DRIVER_PROFILES, composeLogin, emptyLoginParts, loginErrors, type LoginParts } from "../../systems/_lib/register-wizard";
import { MIGRATION_KEYS as K, httpUrl, type ImportFamily } from "./migration";

/**
 * The import page's in-place start (F-1601-c; entitlement
 * `contract.import-in-place.md`): a family whose users keep their login on
 * the reseller's own router is read from that router, registered once
 * (F-1601-g, ADR-0162), never through an address and a login typed for a run.
 */

/** The families imported in place, as billing's `IN_PLACE_DECLARATION` names them. */
const IN_PLACE_FAMILIES = ["mikrotik_user_manager"] as const satisfies readonly ImportFamily[];
export type InPlaceFamily = (typeof IN_PLACE_FAMILIES)[number];

/** Whether a family is read from the reseller's own router: the one place the page asks (C-18). */
export const isInPlaceFamily = (family: string): family is InPlaceFamily => (IN_PLACE_FAMILIES as readonly string[]).includes(family);

/** A router a run may name: its connection test accepted it (billing's `panel_not_found` otherwise). */
export const isPickable = (router: Pick<ResellerRouter, "reviewState">) => router.reviewState === "accepted" || router.reviewState === "accepted_low_trust";

/** A router's test as a pill: green once accepted, quiet while waiting or held, red when refused (systems `REVIEW_TONE`). */
export const ROUTER_TONE: Record<PanelReviewState, Tone> = { pending: "neutral", accepted: "success", accepted_low_trust: "warning", refused: "error" };

/** A connection test's verdict (`network.panel.tested`): the one move of a router the list re-reads on. */
export const ROUTER_EVENTS: readonly string[] = [RealtimeEvents.panelTested];

const NAME_MAX = 100;

export type RouterForm = LoginParts & { name: string; address: string };

export function emptyRouterForm(): RouterForm {
  return { name: "", address: "", ...emptyLoginParts() };
}

export type RouterErrors = Partial<Record<keyof RouterForm, string>>;

/**
 * The register form's errors, as keys. The address is the router's origin:
 * the driver adds `/rest` itself, so a path would be read as `/rest/rest/…`
 * and the router would never answer (network `contract.usermanager.md`).
 */
export function routerFormErrors(form: RouterForm, family: InPlaceFamily = IN_PLACE_FAMILIES[0]): RouterErrors {
  const out: RouterErrors = {};
  const name = form.name.trim();
  if (!name || name.length > NAME_MAX) out.name = K.router.invalid.name;
  const url = httpUrl(form.address);
  if (!url) out.address = K.invalid.address;
  else if (url.pathname !== "/" || url.search || url.hash) out.address = K.router.invalid.addressPath;
  return { ...out, ...routerLoginErrors(form, family) };
}

/** What the form sends once {@link routerFormErrors} is empty: the origin, and the login as network's opener reads it. */
export function routerBodyOf(form: RouterForm, family: InPlaceFamily): RegisterRouterBody {
  return { family, name: form.name.trim(), apiBaseUrl: new URL(form.address.trim()).origin, credentials: composeLogin(DRIVER_PROFILES[family].login, form) };
}

/** A login typed again for a router is checked alone: its name and address are registered already. */
export const routerLoginErrors = (form: LoginParts, family: InPlaceFamily): RouterErrors => loginErrors(DRIVER_PROFILES[family].login, form);

/** A login typed again for a router: the same rules and form as at its registration. */
export const routerLoginOf = (form: LoginParts, family: InPlaceFamily) => composeLogin(DRIVER_PROFILES[family].login, form);

/**
 * Where a router's verdict is heard (`network.panel.tested`, C-14): the
 * reseller's `tenant:` channel, which only a seat of the reseller holds. The
 * owner acting in a reseller's workspace hears nothing and refreshes.
 */
export function routersChannelOf(me: { tenant: { id: string }; permissions: readonly string[] } | null, resellerId: string): string | null {
  return me && me.tenant.id === resellerId ? tenantChannelOf(me) : null;
}

/** The label of a run's read again: a balance file's check, a router's read, else a link's. */
export function recheckKeyOf(run: Pick<MigrationRun, "kind" | "sourcePanelId">): string {
  if (run.kind === "csv") return K.csv.recheck;
  return run.sourcePanelId !== null ? K.router.retry : K.link.retry;
}
