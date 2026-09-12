"use client";

import { useCallback, useEffect, useState } from "react";
import {
  billingApi,
  type WalletLedgerRow,
  type WalletPaymentRow,
} from "@/lib/billing-api";
import {
  DEFAULT_PAGE_SIZE,
  ledgerQuery,
  paymentsQuery,
  type FinancialFilters,
} from "../_lib/filters";

export interface FinancialPageState {
  /** Ledger rows, or `null` while the payments tab is open. */
  ledger: WalletLedgerRow[] | null;
  /** Payment attempts, or `null` while the ledger tab is open. */
  payments: WalletPaymentRow[] | null;
  /**
   * The wallet's balance as `billing` last answered it. Only the ledger route
   * carries it, so it survives a trip to the payments tab rather than blanking
   * — it is the same figure, not a stale guess at it.
   */
  balance: string | null;
  total: number;
  pageSize: number;
  /** True while a read for the current filters is in flight — the table shows its skeleton. */
  isLoading: boolean;
  /** What went wrong, already in the user's language, or `null`. */
  error: unknown;
  retry: () => void;
}

/**
 * One page of one of the two lists (F-093-d).
 *
 * **The filters are the key.** A read is bound to the exact query string the
 * filters produce, so a changed filter is a new read and the table is in its
 * loading state until that read lands. Legacy needed a `LoadingContext` and a
 * `TableWrapper` for the same effect, because its data came from a server
 * action and React had no way to know a new one had been asked for; here the
 * hook that fetches is the hook that knows, and the context is gone.
 *
 * **The two lists are two reads.** The tab picks the route, and each route is
 * given only its own filters (`filters.ts`), so a `statuses` filter cannot
 * narrow the ledger and a `search` cannot reach the payments list.
 *
 * Racing is handled the way `useWalletBalance` handles it: one effect, keyed to
 * the query and a retry counter, with an `alive` flag — so a fast answer to an
 * abandoned filter cannot land after a slow answer to the current one.
 */
export function useFinancialPage(filters: FinancialFilters): FinancialPageState {
  const [ledger, setLedger] = useState<WalletLedgerRow[] | null>(null);
  const [payments, setPayments] = useState<WalletPaymentRow[] | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);

  const [asked, setAsked] = useState(0);
  const retry = useCallback(() => setAsked((n) => n + 1), []);

  const { tab } = filters;
  // The query string, not the object: a new object with the same filters in it
  // is the same page and must not cost a second read.
  const query = tab === "ledger" ? ledgerQuery(filters) : paymentsQuery(filters);

  // What this read *is*, as one string. Loading is then derived rather than
  // stored: the skeleton is up in the render that changed the filter, not one
  // render later once an effect has set a flag — which is the flicker of stale
  // rows under a new filter that legacy's `LoadingContext` existed to paper over.
  const key = `${tab}|${query}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const isLoading = loaded !== key;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (tab === "ledger") {
          const page = await billingApi.walletHistory(query);
          if (!alive) return;
          setLedger(page.rows);
          setPayments(null);
          setBalance(page.balance);
          setTotal(page.total);
        } else {
          const page = await billingApi.walletPayments(query);
          if (!alive) return;
          setPayments(page.rows);
          setLedger(null);
          setTotal(page.total);
        }
        setError(null);
      } catch (e) {
        // A 400 about a filter and a 429 from the limiter both arrive
        // translated; the caller shows the text as it came. Rows are cleared
        // because a failed read is not an empty list, and showing the previous
        // filter's rows under the new filter's heading would be a lie.
        if (!alive) return;
        setError(e);
        setLedger(null);
        setPayments(null);
        setTotal(0);
      } finally {
        if (alive) setLoaded(key);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, query, key]);

  return { ledger, payments, balance, total, pageSize: DEFAULT_PAGE_SIZE, isLoading, error, retry };
}
