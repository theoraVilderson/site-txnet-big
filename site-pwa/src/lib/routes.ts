/**
 * Panel routes. Relative on purpose: this app *is* `panel.<domain>` and each
 * tenant is served on its own white-label domain, so an absolute URL would
 * pin every tenant to one host.
 */
export const PANEL_HOME = "/";
export const AUTH_LOGIN = "/auth/login";
/** Adding another account to the switch group (F-0205 / F-0209). */
export const PANEL_ACCOUNTS_ADD = "/accounts/add";
