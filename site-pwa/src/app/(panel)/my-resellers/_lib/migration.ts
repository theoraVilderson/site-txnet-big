import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import type { MigrationInbound, MigrationRun, UsersCatalogProduct } from "@/lib/billing-api";
import { userChannel } from "@/lib/realtime";
import { tenantChannelOf } from "@/lib/tenant-channel";
import { DRIVER_PROFILES, composeLogin, loginErrors, type LoginParts } from "../../systems/_lib/register-wizard";
import type { DRIVER_TYPES } from "../../systems/_lib/systems";

/**
 * The import page (F-201-f, D-63; entitlement `contract.import.md`). Nothing
 * here decides the import — billing plans it and network reads the source —
 * so these are the page's rules: which step a run is on, what the forms send,
 * and where the page hears a run move.
 */
export const MIGRATION_KEYS = FrontendI18nKeys.common.resellerMigration;
const K = MIGRATION_KEYS;

type DriverType = (typeof DRIVER_TYPES)[number];

/**
 * The families an import reads (network `source.IsFamily`), in the register
 * form's order. Legacy x-ui (vaxilu) is one of them but has no reader yet
 * (`no_driver`, network `contract.source.md` rule 7): offered, it could only fail.
 */
export const IMPORT_FAMILIES = ["marzban", "marzneshin", "sanaee", "three_x_ui", "x_ui_alireza", "s_ui", "hiddify"] as const satisfies readonly DriverType[];
export type ImportFamily = (typeof IMPORT_FAMILIES)[number];

/** tenant `contract.source-login.md`: an address and a login are at most this long. */
const ADDRESS_MAX = 2048;
const LOGIN_MAX = 4096;

/** The page's step for a run; one per status, a draft split by what it is missing. */
export type RunStage = "login" | "mapping" | "reading" | "report" | "importing" | "imported" | "rollingBack" | "closed";

/** Why a preview sent the run back for its mapping (billing's `INBOUNDS_UNMAPPED`); any other reason is the source's. */
const INBOUNDS_UNMAPPED = "inbounds_unmapped";

/**
 * A draft with inbounds read and nothing else wrong is the mapping's; one the
 * source refused, or never read, asks for the login (again) — it also lasts
 * only 7 days unused (tenant rule 4), so a later preview may need it anew.
 */
export function stageOf(run: Pick<MigrationRun, "status" | "failureReason" | "inbounds">): RunStage {
  switch (run.status) {
    case "draft": {
      const mappable = (run.inbounds?.length ?? 0) > 0 && (run.failureReason === null || run.failureReason === INBOUNDS_UNMAPPED);
      return mappable ? "mapping" : "login";
    }
    case "previewing":
      return "reading";
    case "previewed":
      return "report";
    case "committing":
      return "importing";
    case "committed":
      return "imported";
    case "rolling_back":
      return "rollingBack";
    case "rolled_back":
    case "cancelled":
    case "expired":
      return "closed";
  }
}

/** Billing still lets the reseller cancel it (`CANCELLABLE`): nothing was written outside the run. */
export const isCancellable = (run: Pick<MigrationRun, "status">) => run.status === "draft" || run.status === "previewing" || run.status === "previewed";

export type ConnectForm = LoginParts & { family: ImportFamily; address: string; clientBaseUrl: string };

export function emptyConnectForm(family: ImportFamily = IMPORT_FAMILIES[0]): ConnectForm {
  return { family, address: "", clientBaseUrl: "", username: "", password: "", apiKey: "" };
}

/** An absolute http(s) URL within the vault's bound, or null. */
function httpUrl(raw: string): URL | null {
  const value = raw.trim();
  if (!value || value.length > ADDRESS_MAX || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

export type ConnectErrors = Partial<Record<keyof ConnectForm, string>>;

/**
 * The form's errors, as keys. For an existing run the address must be that
 * run's panel: its origin is half of every client's import key
 * (`remoteIdentityOf`), so a login for another origin would read another
 * panel under this run's keys. The login is the register form's, composed
 * the way network's opener reads it (`composeLogin`).
 */
export function connectFormErrors(form: ConnectForm, run: Pick<MigrationRun, "sourceAddress"> | null): ConnectErrors {
  const out: ConnectErrors = {};
  const address = httpUrl(form.address);
  if (!address) out.address = K.invalid.address;
  else if (run && address.origin !== run.sourceAddress) out.address = K.invalid.addressOther;
  if (form.clientBaseUrl.trim() && !httpUrl(form.clientBaseUrl)) out.clientBaseUrl = K.invalid.clientBaseUrl;
  const kind = DRIVER_PROFILES[form.family].login;
  Object.assign(out, loginErrors(kind, form));
  if (Object.keys(out).length === 0 && composeLogin(kind, form).length > LOGIN_MAX) out[kind === "apiKey" ? "apiKey" : "password"] = K.invalid.loginLong;
  return out;
}

/** What the form sends, once {@link connectFormErrors} is empty: the origin to billing, the whole address and login to the vault. */
export function sourceLoginOf(form: ConnectForm) {
  const apiBaseUrl = form.address.trim();
  const clientBaseUrl = form.clientBaseUrl.trim();
  return {
    sourceAddress: new URL(apiBaseUrl).origin,
    login: { apiBaseUrl, ...(clientBaseUrl ? { clientBaseUrl } : {}), login: composeLogin(DRIVER_PROFILES[form.family].login, form) },
  };
}

/** Hiddify logs in with its API key alone (network `contract.source.md` rule 6). */
export const loginKindOfFamily = (family: ImportFamily) => DRIVER_PROFILES[family].login;

/**
 * The plans an inbound may map to: the active prepaid plans of active
 * products. An import brings a bag and an end, never a meter, so a metered
 * plan is billing's `variant_not_prepaid` (rule 10) and is not offered.
 */
export function mappingOptions(products: readonly UsersCatalogProduct[], texts: Record<string, string>): { value: string; label: string }[] {
  return products
    .filter((p) => p.isActive)
    .flatMap((p) =>
      p.variants
        .filter((v) => v.isActive && v.billingMode === "prepaid")
        .map((v) => {
          const name = texts[v.nameKey ?? p.nameKey] || texts[p.nameKey];
          return { value: v.id, label: name ? `${name} · ${v.sku}` : v.sku };
        }),
    );
}

/** The mapping's body: every inbound, the choice made on the page over the run's own, `""` as none. */
export function mappingBody(inbounds: readonly MigrationInbound[], chosen: Readonly<Record<string, string>>) {
  return inbounds.map((i) => {
    const pick = chosen[i.inboundRemoteId] ?? i.variantId ?? "";
    return { inboundRemoteId: i.inboundRemoteId, variantId: pick || null };
  });
}

/** The commit's progress over what it issues — skips are recorded as reached and are not work. */
export function commitProgress(run: Pick<MigrationRun, "plannedCreate" | "plannedUpdate" | "committedItems" | "failedItems">) {
  const total = run.plannedCreate + run.plannedUpdate;
  const done = Math.min(run.committedItems + run.failedItems, total);
  return { done, total, percent: total === 0 ? 100 : Math.round((done / total) * 100) };
}

const DAY_MS = 86_400_000;

/** Whole days left to roll back a committed run (D-63's 7), a part day counted whole; null when it cannot be. */
export function rollbackDaysLeft(run: Pick<MigrationRun, "status" | "rollbackUntil">, now: number = Date.now()): number | null {
  if (run.status !== "committed" || !run.rollbackUntil) return null;
  const left = Date.parse(run.rollbackUntil) - now;
  return left > 0 ? Math.ceil(left / DAY_MS) : null;
}

/** Every move of a run (`announceRun`): previewed, sent back, a commit or rollback batch, its end, a cancel. */
export const MIGRATION_EVENTS: readonly string[] = [RealtimeEvents.migrationRunProgress];

export interface MigrationLive {
  channel: string;
  accepts: (payload: Record<string, unknown>) => boolean;
}

/**
 * Where the page hears this reseller's runs move (C-14). Billing tells the
 * run's tenant and the admin who started it. The owner on the platform's
 * panel is on the platform tenant, so theirs is the `user:` channel; a seat
 * of the reseller also holds its `tenant:` channel, which carries the runs
 * another admin started. Each is narrowed to this reseller.
 */
export function migrationLiveOf(
  me: { userId: string; tenant: { id: string }; permissions: readonly string[] } | null,
  resellerId: string,
): MigrationLive[] {
  if (!me) return [];
  const accepts = (payload: Record<string, unknown>) => payload.tenantId === resellerId;
  const tenant = me.tenant.id === resellerId ? tenantChannelOf(me) : null;
  return [userChannel(me.userId), ...(tenant ? [tenant] : [])].map((channel) => ({ channel, accepts }));
}

/** A reason's sentence from a table of them, or null for one this build does not know (the page then shows the code). */
export function reasonKey(table: Readonly<Record<string, string>>, reason: string | null): string | null {
  return reason !== null && Object.hasOwn(table, reason) ? table[reason] : null;
}

/** Every refusal of the run's routes and the login's, with the reseller door's (billing `MIGRATION_RUN_REJECTIONS`, tenant rule table). */
export const MIGRATION_REFUSAL_KEYS: Readonly<Record<string, string>> = K.refusals;

/** The refusal's own sentence key, when the service named one this page knows. */
export function migrationRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? reasonKey(MIGRATION_REFUSAL_KEYS, reason) : null;
}
