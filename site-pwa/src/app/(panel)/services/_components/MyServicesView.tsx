"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Gauge, PackageOpen } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi } from "@/lib/billing-api";
import { Pagination } from "../../_components/kit/Pagination";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { useGrantsPage } from "../_hooks/useGrantsPage";
import { capabilityNames, serviceName } from "../_lib/my-services";
import { ServiceRow } from "./ServiceRow";

const S = FrontendI18nKeys.common.myServices;

/**
 * The "my services" page (F-502-s): one row per Grant, whatever its status,
 * with the reissue button on each.
 *
 * **The page filters nothing.** Billing answers every Grant the caller has and
 * says what state each is in (`billing/contract.gift.md`), because a
 * subscription key is lost from an expired Grant as easily as from a live one
 * — and hiding the dead ones would hide exactly the row the user came for.
 * There is no status tab here for the same reason.
 *
 * **The URL is the page**, as on the financial page: `?page=` survives a
 * reload and can be sent to support. Nothing is mirrored into a store beside
 * it.
 */
export function MyServicesView() {
  const { t, lang } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toMessage = useApiErrorMessage();

  const asked = Number(searchParams.get("page"));
  const page = Number.isInteger(asked) && asked > 0 ? asked : 1;

  const go = useCallback(
    (next: number) => {
      // `scroll: false` — the list is below the fold on a phone and a page
      // change that jumps to the header hides the rows it just fetched.
      router.push(next === 1 ? pathname : `${pathname}?page=${next}`, { scroll: false });
    },
    [pathname, router],
  );

  const state = useGrantsPage(page, lang);

  // Whether anything is metering the user's configs (F-027-w). A stalled
  // collector reads exactly like a broken service, so the page says which it
  // is. A failure here shows nothing: it is a flag, not the page.
  const [meteringDown, setMeteringDown] = useState(false);
  useEffect(() => {
    let alive = true;
    billingApi
      .collectionHealth()
      .then((h) => alive && setMeteringDown(h.metering === "unavailable"))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-bold text-text-primary md:text-3xl">{t("common", S.title)}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t("common", S.subtitle)}</p>
      </header>

      {meteringDown && (
        <p role="status" className="flex items-start gap-3 rounded-2xl border border-gold/20 bg-gold-bg px-4 py-3 text-sm font-medium text-gold">
          <Gauge size={18} className="mt-0.5 shrink-0" aria-hidden />
          {t("common", S.meteringUnavailable)}
        </p>
      )}

      {state.isLoading && <TableSkeleton rows={3} columns={3} withPagination />}

      {!state.isLoading && state.error != null && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm font-medium text-error"
        >
          <span className="flex items-start gap-3">
            <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
            {/* Billing's sentence where there is one, this app's "unreachable"
                where the call never got an envelope (`contract.errors.md`). */}
            <span className="min-w-0">{toMessage(state.error)}</span>
          </span>
          <button
            type="button"
            onClick={state.retry}
            className="rounded-xl bg-leaf-bg px-4 py-2 text-xs font-bold text-text-primary"
          >
            {t("common", S.retry)}
          </button>
        </div>
      )}

      {!state.isLoading && state.error == null && state.rows?.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-card-border bg-card-bg px-4 py-10 text-center">
          <PackageOpen size={28} className="text-text-secondary" aria-hidden />
          <p className="text-sm text-text-secondary">{t("common", S.empty)}</p>
        </div>
      )}

      {!state.isLoading && state.error == null && (state.rows?.length ?? 0) > 0 && (
        <ul className="space-y-3">
          {state.rows?.map((row) => (
            <ServiceRow
              key={row.id}
              row={row}
              name={serviceName(state.texts, row)}
              capabilities={capabilityNames(state.texts, row)}
              configsAsked={state.configsAsked[row.id]}
            />
          ))}
        </ul>
      )}

      {!state.isLoading && state.error == null && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={state.total}
          pageSize={state.pageSize}
          onPageChange={go}
        />
      )}
    </div>
  );
}
