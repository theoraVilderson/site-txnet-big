/**
 * Where a service's `LanguageMiddleware` leaves the language it resolved from
 * `Accept-Language` (CS-1-a, C-17). The field is named here only: the
 * middleware writes it through `setRequestLanguage`, and everything that
 * answers in a language reads it through `requestLanguage`.
 */
interface LanguageCarrier {
  language?: string;
}

/** Records the request's resolved language; called once, by `LanguageMiddleware`. */
export function setRequestLanguage(req: object, language: string): void {
  (req as LanguageCarrier).language = language;
}

/**
 * The request's language, or the service's `DEFAULT_LANGUAGE` — asked of its
 * `LocaleService`, never a literal (C-17) — when no middleware set one. Empty
 * counts as none.
 */
export function requestLanguage(req: object, locale: { getDefaultLanguage(): string }): string {
  return (req as LanguageCarrier).language || locale.getDefaultLanguage();
}
