/**
 * The language the browser puts on every `auth-api` request.
 *
 * `auth-api` picks the language of an error from `Accept-Language`
 * (`LanguageMiddleware`), and a browser sends the language the *operating
 * system* was set up with — not the one the user chose in this panel. Without
 * this, a user reading the panel in Persian on an en-US browser gets English
 * errors back. `LocaleProvider` keeps the value here in step with the store,
 * next to where it already syncs `document.documentElement.lang`.
 *
 * Null until the provider's first effect: the header is then simply omitted and
 * `auth-api` falls back to its own default, which is the old behaviour.
 */
let language: string | null = null;

export function setApiLanguage(lang: string): void {
  language = lang;
}

export function apiLanguage(): string | null {
  return language;
}
