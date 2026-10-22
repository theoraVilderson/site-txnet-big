"use client";

import { Search, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const S = FrontendI18nKeys.common.myServices.search;

/**
 * The box that narrows one service's configs by name (user, 2026-09-26:
 * "managing 20 configs got hard"). The row owns the query, because the same
 * filter narrows both its config lines and its manage fold; this draws the box
 * and says how many it kept.
 */
export function ConfigSearch({ query, onQuery, shown, total }: { query: string; onQuery: (q: string) => void; shown: number; total: number }) {
  const { t } = useLocale();
  return (
    <div>
      <div className="flex items-center gap-2 rounded-2xl border border-card-border bg-bg-inner px-3 focus-within:border-primary">
        <Search size={16} className="shrink-0 text-text-secondary" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onQuery("");
          }}
          placeholder={t("common", S.placeholder)}
          aria-label={t("common", S.label)}
          dir="auto"
          className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-text-primary outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query !== "" && (
          <button
            type="button"
            onClick={() => onQuery("")}
            aria-label={t("common", S.clear)}
            title={t("common", S.clear)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
          >
            <X size={16} aria-hidden />
          </button>
        )}
      </div>
      {query.trim() !== "" && (
        <p role="status" className="mt-1.5 text-xs text-text-secondary">
          {shown === 0 ? t("common", S.none, { query: query.trim() }) : t("common", S.count, { shown, total })}
        </p>
      )}
    </div>
  );
}
