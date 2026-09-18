/**
 * Panel routes. Relative on purpose: this app *is* `panel.<domain>` and each
 * tenant is served on its own white-label domain, so an absolute URL would
 * pin every tenant to one host.
 */
export const PANEL_HOME = "/";
export const AUTH_LOGIN = "/auth/login";
export const AUTH_FORGOT_PASSWORD = "/auth/forgot-password";
/**
 * Where a reseller's own domain spends a handoff code from the platform panel
 * (F-061-f). The code rides in the fragment, which no request carries.
 */
export const AUTH_HANDOFF = "/auth/handoff";
/**
 * The account-creation screen. `register` is the name auth-api, the bot and
 * coinsite have always used; the panel called it `signup` until this constant
 * existed and the path was written out by hand at each call site.
 */
export const AUTH_REGISTER = "/auth/register";
/** Adding another account to the switch group (F-0205 / F-0209). */
export const PANEL_ACCOUNTS_ADD = "/accounts/add";
/** The user's own settings; first section: their email address (F-035-j). */
export const PANEL_SETTINGS = "/settings";
/**
 * The financial history page (F-093-d) — the wallet ledger and the top-up
 * attempts, as two lists. The sidebar's `financial-history` entry and the
 * wallet control's `history` quick action both point here.
 */
export const PANEL_FINANCIAL = "/financial";
/**
 * The top-up page (F-093-e). Under `/financial` on purpose: `activeHref` then
 * lights the financial group for it without a second rule
 * (`panel-web/contract.shell.md` rule 3).
 */
export const PANEL_DEPOSIT = "/financial/deposit";
/** A reseller's billing wallet with the platform (F-019-d). */
export const PANEL_TENANT_BILLING = "/financial/billing";
/**
 * A reseller tops up that wallet (F-019-e). Under the billing page, so
 * `activeHref` lights its menu entry without a rule of its own.
 */
export const PANEL_TENANT_BILLING_TOPUP = "/financial/billing/topup";
/**
 * Payment gateway management (F-102-d). One route for every audience: the
 * platform owner sees every gateway and the links, a tenant its own (D-31).
 * No role word in it (F-098).
 */
export const PANEL_GATEWAYS = "/gateways";
/**
 * Coupon and gift-code management (F-502-g/h). One route for every audience:
 * billing answers the platform owner every coupon, a tenant its own (D-33).
 */
export const PANEL_COUPONS = "/coupons";
/**
 * Catalog management (F-026-f). One route for every audience: billing answers
 * the platform owner every item, a tenant its own (D-34).
 */
export const PANEL_CATALOG = "/catalog";
/**
 * Catalog translation review (F-1533-e, ADR-0050): machine drafts of item
 * names beside their fa/en source, published by a person. Same audience rule.
 */
export const PANEL_CATALOG_TRANSLATIONS = "/catalog/translations";
/** Payments the gateway has not confirmed, for a person to settle (F-093-n). */
export const PANEL_MANUAL_PAYMENTS = "/payments/manual";
/**
 * Where a bank returns a payer (F-093-f). These two are `billing`'s to name:
 * `deposit-callback.controller.ts` redirects to them by path, so they are the
 * one pair of routes here that cannot be renamed from this side alone.
 */
export const PAYMENT_SUCCESS = "/payment/success";
export const PAYMENT_FAILED = "/payment/failed";
/** A verifying payment (F-093-l): billing's callback writes this path out too. */
export const PAYMENT_PENDING = "/payment/pending";
