"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { HandCoins } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { billingApi, type TenantWalletPage } from "@/lib/billing-api";
import { PANEL_TENANT_BILLING_TOPUP } from "@/lib/routes";
import { formatMoney } from "../../../_lib/money";
import { Pagination } from "../../../_components/kit/Pagination";
import { FinancialTable } from "../../_components/FinancialTable";
import { TenantBillingRow } from "./TenantBillingRow";

const B = FrontendI18nKeys.common.tenantBilling;

const PAGE_SIZE = 20;

/** `?page=` as a positive whole number; anything else is the first page. */
function pageOf(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * A reseller's billing wallet with the platform (F-019-d, D-41): the balance
 * and every movement of it, newest first.
 *
 * The rules are the financial page's (`panel-web/contract.financial.md`): the
 * page number is in the URL; the header figure is the route's `balance`, never
 * a sum of the rows; a failed read shows the server's translated line and a
 * retry, never the empty state; loading is derived from which read last landed.
 * Who may see it is the service's to decide — a refusal is that failed read.
 */
export function TenantBillingView() {
  const { lang, t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const page = pageOf(useSearchParams().get("page"));

  const [data, setData] = useState<TenantWalletPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const retry = useCallback(() => setAsked((n) => n + 1), []);

  const key = `${page}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const isLoading = loaded !== key;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const answer = await billingApi.tenantWallet(page, PAGE_SIZE);
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
  }, [page, key]);

  const go = (next: number) =>
    router.push(next > 1 ? `${pathname}?page=${next}` : pathname, { scroll: false });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">{t("common", B.title)}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", B.subtitle)}</p>
        </div>
        {data && (
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-card-border bg-card-bg px-5 py-3">
              <p className="text-[11px] text-text-secondary">{t("common", B.balance)}</p>
              <p dir="ltr" className="text-lg font-bold text-gold">
                {formatMoney(data.balance, data.currencyCode, { lang, t })}
              </p>
            </div>
            {/* Only once the wallet read succeeded: a refused reader would be refused there too (F-019-e). */}
            <Link
              href={PANEL_TENANT_BILLING_TOPUP}
              className="inline-flex items-center gap-2 rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-white hover:brightness-110"
            >
              <HandCoins size={16} aria-hidden />
              {t("common", B.topup)}
            </Link>
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
        emptyLabel={t("common", B.empty)}
        isEmpty={rows.length === 0}
      >
        {rows.map((row) => (
          <TenantBillingRow key={row.id} row={row} />
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
    </div>
  );
}
