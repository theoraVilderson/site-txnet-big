"use client";

import { useCallback, useEffect, useState } from "react";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { flattenTexts } from "../../catalog/_lib/catalog-form";

/** Billing's own default page size (`GrantService.listForUser`), sent explicitly. */
export const PAGE_SIZE = 20;

export interface GrantsPageState {
  rows: GrantRow[] | null;
  total: number;
  pageSize: number;
  /** The published `catalog` namespace in the viewer's language, flat by full key. */
  texts: Record<string, string>;
  isLoading: boolean;
  /** What went wrong, already in the user's language, or `null`. */
  error: unknown;
  retry: () => void;
}

/**
 * One page of the caller's own Grants, plus the names to show them under
 * (F-502-s).
 *
 * **The names are a second read, and a failing one costs only the names.**
 * Billing answers a `nameKey`, not a translated string
 * (`billing/contract.gift.md`), so the published `catalog` namespace is what
 * turns it into words — the same route and the same flattening the catalog
 * page uses. A language with no catalog text answers 404, which is `{}`: the
 * rows then read by their SKU rather than not at all.
 *
 * Racing is handled the way `useFinancialPage` handles it: one effect keyed to
 * the page, the language and a retry counter, with an `alive` flag, so a fast
 * answer to an abandoned page cannot land after a slow answer to the current
 * one.
 */
export function useGrantsPage(page: number, lang: string): GrantsPageState {
  const [rows, setRows] = useState<GrantRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);

  const [asked, setAsked] = useState(0);
  const retry = useCallback(() => setAsked((n) => n + 1), []);

  // What this read *is*, as one string: loading is derived rather than stored,
  // so the skeleton is up in the render that changed the page rather than one
  // render later (`contract.financial.md`'s hook has the longer note).
  const key = `${page}|${lang}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const isLoading = loaded !== key;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [answer, catalogTexts] = await Promise.all([
          billingApi.grants(page, PAGE_SIZE),
          catalogApi.texts(lang).then(flattenTexts).catch(() => ({})),
        ]);
        if (!alive) return;
        setRows(answer.rows);
        setTotal(answer.total);
        setTexts(catalogTexts);
        setError(null);
      } catch (e) {
        // A failed read is not an empty list: the rows go, because showing the
        // previous page's services under a failure would be a lie.
        if (!alive) return;
        setError(e);
        setRows(null);
        setTotal(0);
      } finally {
        if (alive) setLoaded(key);
      }
    })();
    return () => {
      alive = false;
    };
  }, [page, lang, key]);

  return { rows, total, pageSize: PAGE_SIZE, texts, isLoading, error, retry };
}
