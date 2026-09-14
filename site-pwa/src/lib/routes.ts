/**
 * Panel routes. Relative on purpose: this app *is* `panel.<domain>` and each
 * tenant is served on its own white-label domain, so an absolute URL would
 * pin every tenant to one host.
 */
export const PANEL_HOME = "/";
export const AUTH_LOGIN = "/auth/login";
export const AUTH_FORGOT_PASSWORD = "/auth/forgot-password";
/**
 * The account-creation screen. `register` is the name auth-api, the bot and
 * coinsite have always used; the panel called it `signup` until this constant
 * existed and the path was written out by hand at each call site.
 */
export const AUTH_REGISTER = "/auth/register";
/** Adding another account to the switch group (F-0205 / F-0209). */
export const PANEL_ACCOUNTS_ADD = "/accounts/add";
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
/**
 * Payment gateway management (F-102-d). One route for every audience: the
 * platform owner sees every gateway and the links, a tenant its own (D-31).
 * No role word in it (F-098).
 */
export const PANEL_GATEWAYS = "/gateways";
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
