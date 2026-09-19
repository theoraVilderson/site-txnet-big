import type { Me } from "@/lib/auth-api";
import type { PackageOffer, PurchaseBody, ResellerBillingModel } from "@/lib/tenant-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RESERVED_SLUGS, type Errors } from "./resellers";

/** The page's strings as generated constants (C-06). */
export const PURCHASE_KEYS = FrontendI18nKeys.common.resellerPurchase;
const K = PURCHASE_KEYS;

/**
 * Every reason `POST /tenants/purchase` and its two reads can refuse with
 * (`tenant-service/src/app/purchase/reseller-purchase.service.ts`). Its own
 * union, not the administration page's: the same word means something else to
 * a buyer — `insufficient_balance` here is the buyer's own wallet, there a
 * reseller's balance with the platform.
 */
export type PurchaseRefusal =
  | "not_platform_user"
  | "package_not_found"
  | "buyer_inactive"
  | "already_reseller"
  | "slug_taken"
  | "insufficient_balance"
  | "wallet_changed"
  | "package_inactive"
  | "package_not_sold_for_period";

export const PURCHASE_REFUSAL_KEYS: Record<PurchaseRefusal, string> = K.refusals;

const reasonOf = (e: unknown) => (e as { reason?: unknown } | null)?.reason;

/** The refusal's own sentence key, when the service named one this page knows. */
export function purchaseRefusalKey(e: unknown): string | null {
  const reason = reasonOf(e);
  return typeof reason === "string" && reason in PURCHASE_REFUSAL_KEYS
    ? PURCHASE_REFUSAL_KEYS[reason as PurchaseRefusal]
    : null;
}

/** The one refusal a sentence cannot answer on its own: it needs the top-up beside it. */
export const isInsufficientBalance = (e: unknown) => reasonOf(e) === "insufficient_balance";

/**
 * Who may buy: any signed-in user of the platform owner's tenant, and no
 * permission key — a reseller's own user is refused `not_platform_user`, which
 * stays the boundary. Deliberately not `canAdministerResellers`: the buyer of
 * a reseller is the visitor this page exists for, and they hold nothing.
 */
export const canBuyReseller = (me: Me | null) => me?.tenant?.type === "platform_owner";

/** The period's own price, `null` when the package is not sold for it. */
export const offerPrice = (offer: PackageOffer, period: ResellerBillingModel) =>
  period === "subscription_yearly" ? offer.yearlyPrice : offer.monthlyPrice;

/**
 * The packages the purchase would take for `period`. No `isActive` filter: the
 * route answers a buyer, so it lists the active ones already, and it reads them
 * again under the package's lock (`package_inactive`).
 */
export const offerChoices = (offers: readonly PackageOffer[], period: ResellerBillingModel) =>
  offers.filter((offer) => offerPrice(offer, period) !== null);

// tenant-service's own shapes, so a refusal is caught before the call.
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NAME_MAX = 100;

export interface PurchaseForm {
  packageId: string;
  billingModel: ResellerBillingModel;
  name: string;
  /** The suggestion, or what the buyer typed over it. Empty means "take the suggestion". */
  slug: string;
}

export const emptyPurchaseForm = (): PurchaseForm => ({
  packageId: "",
  billingModel: "subscription_monthly",
  name: "",
  slug: "",
});

const slugOf = (raw: string) => raw.trim().toLowerCase();

export function validatePurchase(form: PurchaseForm): Errors<PurchaseForm> {
  const errors: Errors<PurchaseForm> = {};
  const name = form.name.trim();
  const slug = slugOf(form.slug);
  if (!form.packageId) errors.packageId = K.errors.packageId;
  if (name.length < 1 || name.length > NAME_MAX) errors.name = K.errors.name;
  if (slug && (!DNS_LABEL.test(slug) || (RESERVED_SLUGS as readonly string[]).includes(slug)))
    errors.slug = K.errors.slug;
  return errors;
}

/**
 * The body the `.strict()` schema takes; call after {@link validatePurchase}.
 * An empty `slug` is left out rather than sent as `""`, which the schema
 * refuses — absent means "take the one the name suggests".
 */
export function purchaseBody(form: PurchaseForm): PurchaseBody {
  const slug = slugOf(form.slug);
  return {
    packageId: form.packageId,
    billingModel: form.billingModel,
    name: form.name.trim(),
    ...(slug ? { slug } : {}),
  };
}

/**
 * The name worth asking a suggestion for, or `null` while it is outside what
 * `GET /tenants/purchase/slug` takes. The suggestion is asked as the name is
 * typed, and the read budget is shared with the package list, so a name the
 * route would refuse is never sent.
 */
export function suggestibleName(raw: string): string | null {
  const name = raw.trim();
  return name.length >= 1 && name.length <= NAME_MAX ? name : null;
}
