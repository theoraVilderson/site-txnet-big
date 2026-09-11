"use client";

import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PAGE_GAP, pageItems, pageRange } from "../../_lib/pagination";

const P = FrontendI18nKeys.common.kit.pagination;

export interface PaginationProps {
  /** 1-based. */
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  /**
   * Called with a page other than the current one. The page decides what that
   * means — a `?page=` push, a skeleton — so this bar needs no router and no
   * loading context (legacy reached into both).
   */
  onPageChange: (page: number) => void;
}

/**
 * The bar under a paged table (F-093-b): "showing 11–20 of 94", previous /
 * next, and the page numbers from `sm` up. Renders nothing for a single page.
 */
export function Pagination({ page, totalPages, totalItems, pageSize, onPageChange }: PaginationProps) {
  const { lang, t } = useLocale();
  if (totalPages <= 1) return null;

  const n = new Intl.NumberFormat(lang);
  const { from, to } = pageRange(page, pageSize, totalItems);
  const go = (target: number) => {
    if (target >= 1 && target <= totalPages && target !== page) onPageChange(target);
  };
  const step =
    "rounded-lg p-2 text-text-secondary transition-all hover:bg-leaf-bg hover:text-text-primary active:scale-95 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <nav
      aria-label={t("common", P.navigation)}
      className="mt-6 flex flex-col items-center justify-between gap-4 border-t border-card-border py-4 md:flex-row"
    >
      <p className="order-2 text-sm text-text-secondary md:order-1">
        {t("common", P.summary, { from: n.format(from), to: n.format(to), total: n.format(totalItems) })}
      </p>

      <div className="order-1 flex items-center gap-2 rounded-xl border border-card-border bg-card-bg p-1 md:order-2">
        {/* Previous points toward the inline start: left in LTR, right in RTL. */}
        <button type="button" onClick={() => go(page - 1)} disabled={page === 1} aria-label={t("common", P.previous)} className={step}>
          <ChevronLeft size={18} className="rtl:-scale-x-100" />
        </button>

        <div className="hidden items-center gap-1 sm:flex">
          {pageItems(page, totalPages).map((item, i) =>
            item === PAGE_GAP ? (
              <span key={`gap-${i}`} aria-hidden className="px-2 text-text-secondary">
                <MoreHorizontal size={16} />
              </span>
            ) : (
              <button
                key={item}
                type="button"
                onClick={() => go(item)}
                aria-label={t("common", P.goTo, { page: n.format(item) })}
                aria-current={item === page ? "page" : undefined}
                className={`h-9 min-w-9 rounded-lg text-sm font-medium transition-all ${
                  item === page
                    ? "bg-primary text-white shadow-md shadow-primary-glow"
                    : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
                }`}
              >
                {n.format(item)}
              </button>
            ),
          )}
        </div>

        <span className="px-2 text-sm font-medium text-text-primary sm:hidden">
          {n.format(page)} / {n.format(totalPages)}
        </span>

        <button type="button" onClick={() => go(page + 1)} disabled={page === totalPages} aria-label={t("common", P.next)} className={step}>
          <ChevronRight size={18} className="rtl:-scale-x-100" />
        </button>
      </div>
    </nav>
  );
}
