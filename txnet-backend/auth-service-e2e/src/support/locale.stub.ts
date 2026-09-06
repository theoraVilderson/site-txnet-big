/**
 * `LocaleService` talks gRPC to locale-service, which is a separate product
 * (`i18n-platform/`) with its own tests. Standing one up would make every
 * auth spec depend on it, so it is the one collaborator this suite replaces.
 *
 * The stub translates nothing: `getKey` returns undefined, so
 * `I18nExceptionFilter` falls back to the key itself and an error body's
 * `msg` is the i18n key verbatim. That is exactly what the specs want to
 * assert — the contract is about *which* key comes back, not about the
 * Persian sentence locale-service would render it as.
 */
export class LocaleStub {
  static readonly DEFAULT_LANGUAGE = 'fa';
  static readonly LANGUAGES = ['fa', 'en'];

  getDefaultLanguage(): string {
    return LocaleStub.DEFAULT_LANGUAGE;
  }

  getAvailableLanguages(): string[] {
    return [...LocaleStub.LANGUAGES];
  }

  /** Mirrors the real "first acceptable language, else default" behaviour. */
  resolveLanguage(acceptLanguage?: string): string {
    const wanted = (acceptLanguage ?? '')
      .split(',')
      .map((part) => part.split(';')[0].trim().toLowerCase().split('-')[0])
      .filter(Boolean);
    return (
      wanted.find((lang) => LocaleStub.LANGUAGES.includes(lang)) ??
      LocaleStub.DEFAULT_LANGUAGE
    );
  }

  getKey(): string | undefined {
    return undefined;
  }

  getNamespace(): Record<string, unknown> | undefined {
    return undefined;
  }

  getAll(): Record<string, unknown> {
    return {};
  }

  async reload(): Promise<void> {
    /* nothing to reload */
  }
}
