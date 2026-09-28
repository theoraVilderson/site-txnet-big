"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { formatMoney } from "../../_lib/money";
import { Pagination } from "../../_components/kit/Pagination";
import { useFinancialPage } from "../_hooks/useFinancialPage";
import {
  filtersToParams,
  forTab,
  parseFilters,
  type FinancialFilters,
  type FinancialTab,
} from "../_lib/filters";
import { AdvancedFilter } from "./AdvancedFilter";
import { FinancialTable } from "./FinancialTable";
import { LedgerRow } from "./LedgerRow";
import { PaymentRow } from "./PaymentRow";

const F = FrontendI18nKeys.common.financial;

const TABS: FinancialTab[] = ["ledger", "payments"];

/**
 * The financial page (F-093-d).
 *
 * **The URL is the state.** Filters, page and tab are read from the query
 * string and written back to it, so a filtered view is a link that survives a
 * reload and can be sent to support. Nothing is mirrored into a store beside
 * it, which is what kept legacy's filter panel and its table disagreeing about
 * what was applied.
 *
 * **Two tabs, because they are two lists.** A ledger row is a movement of
 * money and a payment attempt is a request that may have moved none
 * (`domains/billing/contract.history.md`). Legacy showed them as one table and
 * ran a balance down it, so an abandoned top-up shifted every row above it.
 * Separating them here is not a layout choice; it is the reason F-092-n exists.
 */
export function FinancialView() {
  const { lang, t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo(
    () => parseFilters(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const go = useCallback(
    (next: FinancialFilters) => {
      const query = filtersToParams(next).toString();
      // `scroll: false` — the table is below the fold on a phone and a page
      // change that jumps to the header hides the rows it just fetched.
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const page = useFinancialPage(filters);
  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));

  const columns =
    filters.tab === "ledger"
      ? [F.columns.type, F.columns.description, F.columns.amount, F.columns.date, F.columns.balanceAfter]
      : [F.columns.status, F.columns.description, F.columns.amount, F.columns.date, F.columns.gateway];

  const rows = filters.tab === "ledger" ? page.ledger : page.payments;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">{t("common", F.title)}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", F.subtitle)}</p>
        </div>
        {/* The same figure the top bar shows, read from the same field of the
            same route — never a total added up from the rows on screen. */}
        {page.balance !== null && (
          <div className="rounded-2xl border border-card-border bg-card-bg px-5 py-3">
            <p className="text-[11px] text-text-secondary">{t("common", F.balance)}</p>
            <p dir="ltr" className="text-lg font-bold text-gold">
              {formatMoney(page.balance.balance, page.balance.currencyCode, { lang, t })}
            </p>
          </div>
        )}
      </header>

      <div
        role="tablist"
        aria-label={t("common", F.title)}
        className="flex w-fit gap-1 rounded-xl border border-card-border bg-card-bg p-1"
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={filters.tab === tab}
            onClick={() => filters.tab !== tab && go(forTab(filters, tab))}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-all ${
              filters.tab === tab
                ? "bg-primary text-white shadow-md shadow-primary-glow"
                : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
            }`}
          >
            {t("common", F.tabs[tab])}
          </button>
        ))}
      </div>

      <AdvancedFilter filters={filters} onApply={(next) => go({ ...next, page: 1 })} />

      <FinancialTable
        columns={columns.map((key) => t("common", key))}
        isLoading={page.isLoading}
        error={page.error}
        onRetry={page.retry}
        emptyLabel={t("common", F.empty[filters.tab])}
        isEmpty={(rows?.length ?? 0) === 0}
      >
        {filters.tab === "ledger"
          ? page.ledger?.map((row) => <LedgerRow key={row.id} row={row} />)
          : page.payments?.map((row) => <PaymentRow key={row.id} row={row} />)}
      </FinancialTable>

      {!page.isLoading && !page.error && (
        <Pagination
          page={filters.page}
          totalPages={totalPages}
          totalItems={page.total}
          pageSize={page.pageSize}
          onPageChange={(next) => go({ ...filters, page: next })}
        />
      )}
    </div>
  );
}
