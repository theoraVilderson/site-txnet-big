/**
 * Panel routes. Relative on purpose: this app *is* `panel.<domain>` and each
 * tenant is served on its own white-label domain, so an absolute URL would
 * pin every tenant to one host.
 */
export const PANEL_HOME = "/";
export const AUTH_LOGIN = "/auth/login";
/**
 * The account-creation screen. `register` is the name auth-api, the bot and
 * coinsite have always used; the panel called it `signup` until this constant
 * existed and the path was written out by hand at each call site.
 */
export const AUTH_REGISTER = "/auth/register";
/** Adding another account to the switch group (F-0205 / F-0209). */
export const PANEL_ACCOUNTS_ADD = "/accounts/add";
