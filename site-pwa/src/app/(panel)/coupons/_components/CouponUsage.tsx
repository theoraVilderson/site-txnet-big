"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, RotateCw, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type CouponUsageReport } from "@/lib/billing-api";
import { Pagination } from "../../_components/kit/Pagination";
import { BASE_CURRENCY, formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import { COUPON_KEYS as K, refusalKey } from "../_lib/coupon-form";

const U = K.usage;

/**
 * Who used a coupon or a batch (F-502-e): the totals first — what it gave, what
 * is still on hold — then each redemption. `load` is the coupon's or the
 * batch's report; the view does not know which.
 */
export function CouponUsage({
  coupon,
  title,
  load,
  onClose,
}: {
  coupon?: { id: string; code: string };
  title?: string;
  load?: (page: number) => Promise<CouponUsageReport>;
  onClose: () => void;
}) {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [page, setPage] = useState(1);
  const [report, setReport] = useState<CouponUsageReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  const fetchPage = useCallback(
    async (p: number) => {
      try {
        setReport(await (load ? load(p) : billingApi.couponUsage(coupon!.id, { page: p, pageSize: 20 })));
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [coupon, load],
  );

  useEffect(() => {
    // Every setState in fetchPage runs after its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPage(page);
  }, [fetchPage, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  const money = (amount: string) => formatMoney(amount, BASE_CURRENCY, { lang, t });
  const totals = report?.totals;
  const tiles: Array<[string, string]> = totals
    ? [
        [t("common", U.totals.redemptions), String(totals.redemptions)],
        [t("common", U.totals.used), String(totals.used)],
        [t("common", U.totals.reserved), String(totals.reserved)],
        [t("common", U.totals.released), String(totals.released)],
        [t("common", U.totals.discountGiven), money(totals.discountGiven)],
      ]
    : [];

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-t-3xl border border-card-border bg-card-bg shadow-xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b border-card-border p-4">
          <h2 className="text-sm font-bold text-text-primary">{title ?? t("common", U.title, { code: coupon?.code ?? "" })}</h2>
          <button type="button" onClick={onClose} aria-label={t("common", U.close)} className="rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="alert" className="text-xs font-bold text-error">
                {refusalKey(error) ? t("common", refusalKey(error)!) : errorMessage(error)}
              </p>
              <button type="button" onClick={() => void fetchPage(page)} className="inline-flex items-center gap-1 text-xs font-bold text-primary">
                <RotateCw size={14} aria-hidden />
                {t("common", K.retry)}
              </button>
            </div>
          ) : !report ? (
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              {t("common", U.loading)}
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {tiles.map(([label, value]) => (
                  <div key={label} className="rounded-2xl bg-[var(--leaf-bg)] p-3">
                    <dt className="text-[11px] text-text-secondary">{label}</dt>
                    <dd className="text-sm font-bold text-text-primary">{value}</dd>
                  </div>
                ))}
              </dl>
              {report.items.length === 0 ? (
                <p className="py-4 text-center text-sm text-text-secondary">{t("common", U.empty)}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-start text-xs">
                    <thead className="text-text-secondary">
                      <tr>
                        {(["code", "user", "payment", "amount", "status", "time"] as const).map((c) => (
                          <th key={c} className="px-2 py-2 text-start font-bold">
                            {t("common", U.columns[c])}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card-border text-text-primary">
                      {report.items.map((r) => (
                        <tr key={r.id}>
                          <td className="px-2 py-2 font-mono" dir="ltr">
                            {r.code}
                          </td>
                          <td className="px-2 py-2">
                            {r.userName ?? "—"}
                            <span dir="ltr" className="block font-mono text-[10px] text-text-secondary">
                              {r.username ?? r.userId.slice(0, 8)}
                            </span>
                          </td>
                          <td className="px-2 py-2 font-mono text-[10px]" dir="ltr">
                            {r.paymentTransactionId ? `${r.paymentTransactionId.slice(0, 8)} · ${r.paymentStatus ?? ""}` : "—"}
                          </td>
                          <td className="px-2 py-2">{money(r.discountAmount)}</td>
                          <td className="px-2 py-2">{t("common", U.status[r.status])}</td>
                          <td className="px-2 py-2">{formatInstant(r.redeemedAt, lang) ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {report.total > report.pageSize && (
                <Pagination page={report.page} totalPages={Math.ceil(report.total / report.pageSize)} totalItems={report.total} pageSize={report.pageSize} onPageChange={setPage} />
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
