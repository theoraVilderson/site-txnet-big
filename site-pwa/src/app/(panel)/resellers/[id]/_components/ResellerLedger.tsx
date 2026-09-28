"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { billingApi, type TenantWalletAdminPage } from "@/lib/billing-api";
import { formatMoney } from "../../../_lib/money";
import { Pagination } from "../../../_components/kit/Pagination";
import { FinancialTable } from "../../../financial/_components/FinancialTable";
import { TenantBillingRow } from "../../../financial/billing/_components/TenantBillingRow";
import { RESELLER_KEYS as K } from "../../_lib/resellers";

/** The column headings and the reason labels are the reseller's own ledger's (F-019-d). */
const B = FrontendI18nKeys.common.tenantBilling;

const PAGE_SIZE = 20;

/** `?page=` as a positive whole number; anything else is the first page. */
function pageOf(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * One reseller's billing ledger as the platform owner reads it (F-019-j) —
 * the same rows a reseller sees of its own wallet (`contract.financial.md`),
 * plus the reference of each movement, so an adjustment can be traced back to
 * the request that made it.
 *
 * The financial page's rules hold: the page number is in the URL, the header
 * figure is the route's `balance` and never a sum of the rows, a failed read
 * shows the server's translated line and a retry rather than the empty state.
 * `reloadKey` is the page's write counter: an adjustment moves the balance, so
 * the ledger is read again with it.
 */
export function ResellerLedger({ tenantId, reloadKey }: { tenantId: string; reloadKey: number }) {
  const { lang, t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const page = pageOf(params.get("page"));

  const [data, setData] = useState<TenantWalletAdminPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const retry = useCallback(() => setAsked((n) => n + 1), []);

  const key = `${page}|${asked}|${reloadKey}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const isLoading = loaded !== key;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const answer = await billingApi.tenantWalletTransactions(tenantId, page, PAGE_SIZE);
        if (!alive) return;
        setData(answer);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setData(null);
        setError(e);
      } finally {
        if (alive) setLoaded(key);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tenantId, page, key]);

  // The tab rides along, so paging the ledger does not drop the reader back on the overview.
  const go = (next: number) => router.push(`${pathname}?tab=billing${next > 1 ? `&page=${next}` : ""}`, { scroll: false });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <section className="space-y-4">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-sm font-bold text-text-primary">{t("common", K.detail.ledgerTitle)}</h2>
          <p className="mt-1 text-xs text-text-secondary">{t("common", K.detail.ledgerSubtitle)}</p>
        </div>
        {data && (
          <div className="rounded-2xl border border-card-border bg-card-bg px-5 py-3">
            <p className="text-[11px] text-text-secondary">{t("common", K.columns.balance)}</p>
            <p dir="ltr" className="text-lg font-bold text-gold">
              {formatMoney(data.balance, data.currencyCode, { lang, t })}
            </p>
          </div>
        )}
      </header>

      <FinancialTable
        columns={[
          "",
          t("common", B.columns.type),
          t("common", B.columns.amount),
          t("common", B.columns.date),
          t("common", B.columns.balanceAfter),
        ]}
        isLoading={isLoading}
        error={error}
        onRetry={retry}
        emptyLabel={t("common", K.detail.ledgerEmpty)}
        isEmpty={rows.length === 0}
      >
        {rows.map((row) => (
          <TenantBillingRow key={row.id} row={row} referenceLabel={t("common", K.detail.reference)} />
        ))}
      </FinancialTable>

      {!isLoading && !error && total > 0 && (
        <Pagination
          page={page}
          totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          totalItems={total}
          pageSize={PAGE_SIZE}
          onPageChange={go}
        />
      )}
    </section>
  );
}
