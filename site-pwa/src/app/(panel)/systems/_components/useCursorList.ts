"use client";

import { useCallback, useEffect, useState } from "react";
import type { CursorPage } from "@/lib/billing-api";

/**
 * A keyset-paged list read under a `state` filter: the first page on mount
 * and on every filter change, the next on "load more". Nothing is patched in
 * from an action's answer — `reload` reads the list again, because billing
 * (or the meter) decides what a row became.
 */
export function useCursorList<Row extends { id: string }, S extends string>(
  fetchPage: (query: { state: S; after?: string }) => Promise<CursorPage<Row>>,
  initial: S,
) {
  const [state, setState] = useState<S>(initial);
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    try {
      const page = await fetchPage({ state });
      setRows(page.items);
      setNext(page.next);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, state]);

  const more = useCallback(async () => {
    if (!next) return;
    try {
      const page = await fetchPage({ state, after: next });
      setRows((r) => [...r, ...page.items]);
      setNext(page.next);
    } catch (e) {
      setError(e);
    }
  }, [fetchPage, state, next]);

  useEffect(() => {
    // Every setState in reload runs after its first await, as in `useGateways`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return { state, setState, rows, next, isLoading, error, reload, more };
}
