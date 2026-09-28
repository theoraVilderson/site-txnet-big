import type { Me, UserSearchHit } from "@/lib/auth-api";
import { holdsPermission } from "@/lib/permissions";
import type { TenantLedgerDirection, TenantWalletAdjustBody } from "@/lib/billing-api";
import type {
  CreateResellerBody,
  ResellerBillingModel,
  SettableStatus,
  TenantPackage,
  TenantStatus,
} from "@/lib/tenant-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The page's strings as generated constants (C-06). */
export const RESELLER_KEYS = FrontendI18nKeys.common.resellers;
const K = RESELLER_KEYS;

/** The key tenant-service's reseller, subscription and status routes gate on. */
export const RESELLERS_MANAGE = "tenant.manage";
/** The key auth-service's user search gates on (F-018-ad); the spec reads it from the service. */
export const USER_SEARCH = "user.search";
/** The key billing's manual adjustment gates on (F-019-a). */
export const WALLET_ADJUST = "tenant_billing.adjust";
/**
 * The key billing's read of one reseller's ledger gates on (F-019-j). Its own
 * key, not the adjustment's: reading what the platform charged a reseller is
 * not moving its balance, so a support role may hold this one alone.
 */
export const WALLET_READ = "tenant_billing.read";

/** tenant-service's `BILLING_MODELS` (`reseller.schema.ts`); the spec holds the two together. */
export const BILLING_MODELS = ["subscription_monthly", "subscription_yearly"] as const satisfies readonly ResellerBillingModel[];
/** tenant-service's `RESERVED_SLUGS`; the spec holds the two together. */
export const RESERVED_SLUGS = ["api", "panel", "www", "admin", "app", "mail", "sub", "assets", "static", "cdn", "edge"] as const;
/** What `PUT /tenants/:id/status` takes, in the order it is offered. */
export const SETTABLE_STATUSES = ["active", "suspended", "terminated"] as const satisfies readonly SettableStatus[];

/**
 * Every reason tenant-service (reseller, subscription, status) and billing (the
 * adjustment) can refuse this page with. The spec reads each service's closed
 * union, so a new reason does not ship without its sentence.
 */
export type ResellerRefusal =
  | "not_platform_owner"
  | "reseller_not_found"
  | "owner_not_found"
  | "owner_inactive"
  | "slug_taken"
  | "reseller_terminated"
  | "subscription_not_found"
  | "package_not_found"
  | "package_inactive"
  | "package_not_sold_for_period"
  | "status_unchanged"
  | "tenant_not_found"
  | "not_a_reseller"
  | "invalid_amount"
  | "insufficient_balance"
  | "duplicate_request"
  | "wallet_changed";

export const REFUSAL_KEYS: Record<ResellerRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this page knows. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as ResellerRefusal] : null;
}

/** The answer tenant-service gives a reseller not yet on a package. */
export const isNoSubscription = (e: unknown) => (e as { reason?: unknown } | null)?.reason === "subscription_not_found";

const holds = (me: Me | null, key: string) => holdsPermission(me?.permissions, key);
const onPlatform = (me: Me | null) => me?.tenant?.type === "platform_owner";

/**
 * Who may open the page — the menu entry's rule, for a visitor who typed the
 * path. Both halves: a reseller can grant itself `tenant.manage`, and the
 * service would refuse it anyway (`not_platform_owner`).
 */
export const canAdministerResellers = (me: Me | null) => onPlatform(me) && holds(me, RESELLERS_MANAGE);
export const canAdjustWallet = (me: Me | null) => onPlatform(me) && holds(me, WALLET_ADJUST);
/** Whether the create sheet can search for the owner; without it the sheet takes a user id. */
export const canSearchUsers = (me: Me | null) => onPlatform(me) && holds(me, USER_SEARCH);
/** Whether one reseller's billing ledger can be read (F-019-j). */
export const canReadTenantLedger = (me: Me | null) => onPlatform(me) && holds(me, WALLET_READ);

/**
 * The reseller page's tabs (F-019-k), in the order they are shown. `overview`
 * is the facts, the package and the status; `billing` the ledger and the
 * adjustment. A later section of its own (F-018-h/i/j) is another tab here,
 * not another sheet.
 */
export const RESELLER_TABS = ["overview", "billing"] as const;
export type ResellerTab = (typeof RESELLER_TABS)[number];

/**
 * The tabs this visitor is offered. `billing` needs one of the two billing
 * keys — the ledger's or the adjustment's — because the tab holds both and
 * each section asks for its own inside it.
 */
export function resellerTabs(me: Me | null): ResellerTab[] {
  return RESELLER_TABS.filter((tab) => tab !== "billing" || canReadTenantLedger(me) || canAdjustWallet(me));
}

/** `?tab=` as a tab this visitor may open; anything else is the first one they may. */
export function resellerTab(raw: string | null, tabs: readonly ResellerTab[]): ResellerTab {
  return tabs.find((tab) => tab === raw) ?? tabs[0];
}

// Each service's own shapes, so a refusal is caught before the call.
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const TEXT_MAX = 500;

export type Errors<F> = Partial<Record<keyof F | "confirm", string>>;

// ------------------------------------------------------------------- create

export interface CreateForm {
  slug: string;
  billingModel: ResellerBillingModel | "";
  ownerUserId: string;
}

export const emptyCreateForm = (): CreateForm => ({ slug: "", billingModel: "subscription_monthly", ownerUserId: "" });

const slugOf = (raw: string) => raw.trim().toLowerCase();

export function validateCreate(form: CreateForm): Errors<CreateForm> {
  const errors: Errors<CreateForm> = {};
  const slug = slugOf(form.slug);
  if (!DNS_LABEL.test(slug) || (RESERVED_SLUGS as readonly string[]).includes(slug)) errors.slug = K.errors.slug;
  if (!(BILLING_MODELS as readonly string[]).includes(form.billingModel)) errors.billingModel = K.errors.billingModel;
  if (!UUID.test(form.ownerUserId.trim())) errors.ownerUserId = K.errors.ownerUserId;
  return errors;
}

/** `userSearchSchema`'s bounds (auth-service); the spec holds the two together. */
const USER_QUERY_MIN = 3;
const USER_QUERY_MAX = 64;

/** The query worth sending, or null while it is too short (or too long) for the service to take. */
export function userQuery(raw: string): string | null {
  const q = raw.trim();
  return q.length >= USER_QUERY_MIN && q.length <= USER_QUERY_MAX ? q : null;
}

/** Only an active user can own a reseller; tenant-service answers anyone else `owner_inactive`. */
export const ownerSelectable = (hit: UserSearchHit) => hit.status === "active";

/** The three fields the `.strict()` schema takes; call after {@link validateCreate}. */
export function createBody(form: CreateForm): CreateResellerBody {
  return { slug: slugOf(form.slug), billingModel: form.billingModel as ResellerBillingModel, ownerUserId: form.ownerUserId.trim() };
}

// --------------------------------------------------------- package and period

const priceFor = (p: TenantPackage, period: ResellerBillingModel) =>
  period === "subscription_yearly" ? p.yearlyPrice : p.monthlyPrice;

/**
 * The packages `PUT /subscription` would take for `period`: priced for it, and
 * active — or the one the reseller is already on, which a deactivation leaves
 * it on (`tenant/contract.admin.md`).
 */
export function packageChoices(
  packages: readonly TenantPackage[],
  period: ResellerBillingModel,
  currentPackageId: string | null,
): TenantPackage[] {
  return packages.filter((p) => priceFor(p, period) !== null && (p.isActive || p.id === currentPackageId));
}

export { priceFor };

// ------------------------------------------------------------------- status

/**
 * The statuses worth offering from `current`. Never `trial` (only a start),
 * nothing once `terminated` (final). The current one is left out, except
 * `suspended`: suspending a reseller suspended for non-payment makes the cause
 * `manual`, so a payment no longer reopens it (F-018-s). The service answers
 * `status_unchanged` when it is already manual.
 */
export function statusChoices(current: TenantStatus): SettableStatus[] {
  if (current === "terminated") return [];
  return SETTABLE_STATUSES.filter((s) => s !== current || s === "suspended");
}

export interface StatusForm {
  status: SettableStatus | "";
  reason: string;
  /** Terminating is final: asked for once more, on the page. */
  confirmed: boolean;
}

export function validateStatus(form: StatusForm): Errors<StatusForm> {
  const errors: Errors<StatusForm> = {};
  if (!form.status) errors.status = K.errors.status;
  if (form.reason.trim().length > TEXT_MAX) errors.reason = K.errors.reason;
  if (form.status === "terminated" && !form.confirmed) errors.confirm = K.errors.confirm;
  return errors;
}

export function statusBody(form: StatusForm): { status: SettableStatus; reason?: string } {
  const reason = form.reason.trim();
  return { status: form.status as SettableStatus, ...(reason ? { reason } : {}) };
}

// ------------------------------------------------------------------- adjust

export interface AdjustForm {
  direction: TenantLedgerDirection;
  amount: string;
  note: string;
}

export const emptyAdjustForm = (): AdjustForm => ({ direction: "credit", amount: "", note: "" });

export function validateAdjust(form: AdjustForm): Errors<AdjustForm> {
  const errors: Errors<AdjustForm> = {};
  const amount = form.amount.trim();
  if (!DECIMAL.test(amount) || Number(amount) <= 0) errors.amount = K.errors.amount;
  if (form.note.trim().length > TEXT_MAX) errors.note = K.errors.note;
  return errors;
}

/**
 * The adjustment as billing takes it. `requestId` is the caller's, minted once
 * per filled form: a retry after a lost answer then lands as
 * `duplicate_request` instead of a second movement.
 */
export function adjustBody(form: AdjustForm, requestId: string): TenantWalletAdjustBody {
  const note = form.note.trim();
  return { direction: form.direction, amount: form.amount.trim(), requestId, ...(note ? { note } : {}) };
}
