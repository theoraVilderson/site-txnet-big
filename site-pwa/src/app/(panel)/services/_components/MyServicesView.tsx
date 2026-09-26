"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Gauge, PackageOpen, Search, X } from "lucide-react";
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
 * How many live rows show their configs without a tap. A subscription page
 * shows them all, but each open row is one config-list read against the
 * caller's `CONFIG_LIST` bucket, and a page holds 20 rows; three covers the
 * user with a service or two, and the rest are one tap away.
 */
const AUTO_OPEN = 3;

/**
 * How long typing rests before the search is written to the URL. Each write
 * is one read of billing's list, so a word is one read, not one per letter.
 */
const SEARCH_SETTLE_MS = 350;

/** Billing's own ceiling on `q` (`billing/contract.gift.md`). */
const SEARCH_MAX = 100;

/**
 * The "my services" page (F-502-s): one row per Grant, with the reissue button
 * on each.
 *
 * **Ended services are hidden by default, one tap away** (user, 2026-09-26).
 * Billing leaves `cancelled` and `exhausted` Grants out of the default page
 * and says how many (`billing/contract.gift.md`); the page offers them back
 * with one button, because a link is lost from an ended Grant as easily as
 * from a live one. Expired and suspended Grants stay in the default list.
 * The filter is billing's, never this page's: a page of 20 filtered here
 * would come back short.
 *
 * **The URL is the page**, as on the financial page: `?page=`, `?all=1` and
 * `?q=` survive a reload and can be sent to support. Nothing is mirrored into
 * a store beside them.
 *
 * **A service is found by its configs, and billing does the finding** (F-307-n
 * over F-307-m): one box, written to `?q=` once typing rests, back at page 1.
 * Paging and "show ended" keep it. A page filtered here would come back short,
 * as the ended filter would.
 */
export function MyServicesView() {
  const { t, lang } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toMessage = useApiErrorMessage();

  const asked = Number(searchParams.get("page"));
  const page = Number.isInteger(asked) && asked > 0 ? asked : 1;
  const all = searchParams.get("all") === "1";
  const q = (searchParams.get("q") ?? "").trim();

  const go = useCallback(
    (next: number, showAll: boolean, search: string, how: "push" | "replace" = "push") => {
      const query = new URLSearchParams();
      if (next > 1) query.set("page", String(next));
      if (showAll) query.set("all", "1");
      if (search !== "") query.set("q", search);
      const qs = query.toString();
      // `scroll: false` — the list is below the fold on a phone and a page
      // change that jumps to the header hides the rows it just fetched.
      router[how](qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  // What is typed, ahead of the URL. The URL wins when it moves on its own —
  // back, forward, a link from support — and not when it catches up with
  // what this box sent, or a letter typed meanwhile would be wiped.
  const [draft, setDraft] = useState(q);
  const [sent, setSent] = useState(q);
  if (q !== sent) {
    setSent(q);
    setDraft(q);
  }
  useEffect(() => {
    const wanted = draft.trim();
    if (wanted === sent) return;
    // `replace`: a search being typed is one history entry, not one per word.
    const timer = setTimeout(() => {
      setSent(wanted);
      go(1, all, wanted, "replace");
    }, SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draft, sent, all, go]);

  const state = useGrantsPage(page, lang, all ? "all" : "current", q);

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
  const autoOpen = new Set(
    (state.rows ?? [])
      .filter((r) => r.status === "active" || r.status === "pending")
      .slice(0, AUTO_OPEN)
      .map((r) => r.id),
  );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 p-4 md:p-8">
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

      {(q !== "" || state.total + state.hidden > 0) && (
        <div className="flex items-center gap-2 rounded-2xl border border-card-border bg-card-bg px-3 focus-within:border-primary">
          <Search size={16} className="shrink-0 text-text-secondary" aria-hidden />
          <input
            type="search"
            value={draft}
            maxLength={SEARCH_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft("");
            }}
            placeholder={t("common", S.serviceSearch.placeholder)}
            aria-label={t("common", S.serviceSearch.label)}
            dir="auto"
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-text-primary outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {draft !== "" && (
            <button
              type="button"
              onClick={() => setDraft("")}
              aria-label={t("common", S.serviceSearch.clear)}
              title={t("common", S.serviceSearch.clear)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
            >
              <X size={16} aria-hidden />
            </button>
          )}
        </div>
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
          <p className="text-sm text-text-secondary">
            {q !== ""
              ? t("common", state.hidden > 0 ? S.serviceSearch.noneCurrent : S.serviceSearch.none, { query: q })
              : t("common", state.hidden > 0 ? S.noCurrent : S.empty)}
          </p>
        </div>
      )}

      {!state.isLoading && state.error == null && (state.rows?.length ?? 0) > 0 && (
        <ul className="space-y-4">
          {state.rows?.map((row) => (
            <ServiceRow
              key={row.id}
              row={row}
              name={serviceName(state.texts, row)}
              capabilities={capabilityNames(state.texts, row)}
              configsAsked={state.configsAsked[row.id]}
              autoOpen={autoOpen.has(row.id)}
            />
          ))}
        </ul>
      )}

      {!state.isLoading && state.error == null && (all || state.hidden > 0) && (
        <button
          type="button"
          onClick={() => go(1, !all, q)}
          className="w-full rounded-xl border border-card-border bg-card-bg px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
        >
          {all ? t("common", S.hideEnded) : t("common", S.showEnded, { count: state.hidden })}
        </button>
      )}

      {!state.isLoading && state.error == null && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={state.total}
          pageSize={state.pageSize}
          onPageChange={(next) => go(next, all, q)}
        />
      )}
    </div>
  );
}
