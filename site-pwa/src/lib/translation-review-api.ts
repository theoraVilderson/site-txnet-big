import type { ApiCall } from "./api-request";

/** One machine draft waiting for review, beside its source (`GET …/translations`). */
export interface TranslationDraft {
  lang: string;
  /** The full i18n key the item row holds. */
  key: string;
  draft: string;
  published: string | null;
  /** The item's source language and its published text there. */
  source: { lang: string; text: string | null };
}

/** The four review calls `TranslationsView` makes, whichever service owns the items. */
export type TranslationReviewApi = ReturnType<typeof translationReviewApi>;

/**
 * Translation review over `at` + `/translations` (F-1533-d/e, ADR-0154 (6)):
 * billing's catalog and tenant-service's packages answer the same four routes
 * with the same shapes, so one view reviews both and only `call` and `at` differ.
 * Each service limits every call to the caller's own items.
 */
export function translationReviewApi(call: ApiCall, at: string) {
  const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
  return {
    async translations(lang?: string): Promise<TranslationDraft[]> {
      return call<TranslationDraft[]>(`${at}/translations${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`, { method: "GET" });
    },

    /** Drafts every language that has neither text nor a draft yet. */
    async draftMissing(): Promise<{ drafted: number }> {
      return call<{ drafted: number }>(`${at}/translations/draft-missing`, { method: "POST" });
    },

    async publishTranslations(lang: string, keys: string[]): Promise<{ published: number }> {
      return call<{ published: number }>(`${at}/translations/publish`, { method: "POST", ...json({ lang, keys }) });
    },

    async editTranslations(lang: string, texts: Record<string, string>): Promise<{ published: number }> {
      return call<{ published: number }>(`${at}/translations`, { method: "PATCH", ...json({ lang, texts }) });
    },
  };
}
