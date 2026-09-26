"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Gauge, PackageOpen } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi } from "@/lib/billing-api";
import { Pagination } from "../../_components/kit/Pagination";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { useGrantsPage } from "../_hooks/useGrantsPage";
import { capabilityNames, PASTE_MAX_LINES, pastedLines, serviceName } from "../_lib/my-services";
import { ServiceRow } from "./ServiceRow";
import { ServiceSearch } from "./ServiceSearch";

const S = FrontendI18nKeys.common.myServices;

/**
 * How many live rows show their configs without a tap. A subscription page
 * shows them all, but each open row is one config-list read against the
 * caller's `CONFIG_LIST` bucket, and a page holds 20 rows; three covers the
 * user with a service or two, and the rest are one tap away.
 */
const AUTO_OPEN = 3;

const NO_LINES: readonly string[] = [];

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
 * over F-307-m): one box (`ServiceSearch`, which alone re-renders while
 * typing), written to `?q=` once typing rests, back at page 1.
 * Paging and "show ended" keep it. A page filtered here would come back short,
 * as the ended filter would.
 *
 * **A pasted config is a credential, so it never reaches the URL** (F-307-q
 * over F-307-p). A paste holding `://` is read as up to 20 config links,
 * held by this page alone and sent to billing's `by-lines` in a POST body;
 * the box shows how many, not the links. Paging and "show ended" keep them,
 * a reload, typing a name or clearing drops them.
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

  // Pasted config links (F-307-q): in this state and nowhere else.
  const [pasted, setPasted] = useState<ReturnType<typeof pastedLines> | null>(null);
  // Searches written to the URL that it has not shown yet, oldest first. The
  // URL catching up with one is this page's own write landing; any other move
  // (back, forward, a link from support) is a navigation, and wins.
  const [inFlight, setInFlight] = useState<readonly string[]>([]);
  const [seenQ, setSeenQ] = useState(q);
  const [navigations, setNavigations] = useState(0);
  if (q !== seenQ) {
    setSeenQ(q);
    const own = inFlight.indexOf(q);
    if (own >= 0) {
      setInFlight(inFlight.slice(own + 1));
    } else {
      setInFlight([]);
      setNavigations(navigations + 1);
      // A name arriving in the URL replaces a paste.
      if (q !== "") setPasted(null);
    }
  }
  // Where `?q=` is heading: the last search sent, or where it is.
  const heading = inFlight.length > 0 ? inFlight[inFlight.length - 1] : q;
  // `replace`: a search being typed is one history entry, not one per word.
  const settle = useCallback(
    (search: string) => {
      setInFlight((f) => [...f, search]);
      go(1, all, search, "replace");
    },
    [all, go],
  );
  // A paste replaces a name search and starts at page 1.
  const takePaste = useCallback(
    (text: string): boolean => {
      const found = pastedLines(text);
      if (found.lines.length === 0) return false;
      setPasted(found);
      if (heading !== "") settle("");
      else if (page > 1) go(1, all, "", "replace");
      return true;
    },
    [heading, page, all, go, settle],
  );
  const dropPaste = useCallback(() => setPasted(null), []);

  const state = useGrantsPage(page, lang, all ? "all" : "current", pasted ? "" : q, pasted?.lines ?? NO_LINES);

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
  // Built once per answer, so a memoised row sees the same props on a
  // re-render that did not change it.
  const items = useMemo(() => {
    const rows = state.rows ?? [];
    const autoOpen = new Set(
      rows
        .filter((r) => r.status === "active" || r.status === "pending")
        .slice(0, AUTO_OPEN)
        .map((r) => r.id),
    );
    return rows.map((row) => ({
      row,
      name: serviceName(state.texts, row),
      capabilities: capabilityNames(state.texts, row),
      autoOpen: autoOpen.has(row.id),
    }));
  }, [state.rows, state.texts]);

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

      {(q !== "" || pasted != null || state.total + state.hidden > 0) && (
        <ServiceSearch
          q={q}
          heading={heading}
          navigations={navigations}
          pastedCount={pasted?.lines.length ?? null}
          onSettle={settle}
          onPaste={takePaste}
          onDropPaste={dropPaste}
        />
      )}

      {pasted?.capped && (
        <p role="status" className="px-1 text-xs text-text-secondary">
          {t("common", S.serviceSearch.pastedCapped, { max: PASTE_MAX_LINES })}
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
          <p className="text-sm text-text-secondary">
            {pasted != null
              ? t("common", state.hidden > 0 ? S.serviceSearch.pastedNoneCurrent : S.serviceSearch.pastedNone)
              : q !== ""
              ? t("common", state.hidden > 0 ? S.serviceSearch.noneCurrent : S.serviceSearch.none, { query: q })
              : t("common", state.hidden > 0 ? S.noCurrent : S.empty)}
          </p>
        </div>
      )}

      {!state.isLoading && state.error == null && (state.rows?.length ?? 0) > 0 && (
        <ul className="space-y-4">
          {items.map(({ row, name, capabilities, autoOpen }) => (
            <ServiceRow
              key={row.id}
              row={row}
              name={name}
              capabilities={capabilities}
              configsAsked={state.configsAsked[row.id]}
              autoOpen={autoOpen}
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
