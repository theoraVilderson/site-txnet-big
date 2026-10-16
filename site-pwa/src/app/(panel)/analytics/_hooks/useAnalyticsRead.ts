"use client";

import { useEffect, useState } from "react";
import { useLiveReread } from "@/hooks/useLiveReread";
import { type AnalyticsAnswer, type AnalyticsBodies, type AnalyticsQuery, type AnalyticsTab, readAnalytics } from "@/lib/billing/analytics";
import type { AnalyticsLive } from "../_lib/live";

export interface AnalyticsRead<T extends AnalyticsTab> {
  answer: AnalyticsAnswer<AnalyticsBodies[T]> | null;
  /** The figures on screen are for an older query: the new ones are on their way (rule 11). */
  stale: boolean;
  error: unknown;
  reload: () => void;
}

/**
 * One tab of one tenant, read for `query` and again on every rollup event
 * `live` names (C-14, ADR-0121; `analyticsLiveOf`) — never on a timer. The
 * last answer stays on screen while the next one loads, so a filter change
 * dims the chart instead of flashing a skeleton. A read the next one
 * replaced is dropped by its effect's cleanup. `query` is the caller's
 * memoized object: a new one is a new read.
 */
export function useAnalyticsRead<T extends AnalyticsTab>(tenantId: string | null, tab: T, query: AnalyticsQuery, live: AnalyticsLive): AnalyticsRead<T> {
  const [answer, setAnswer] = useState<AnalyticsAnswer<AnalyticsBodies[T]> | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  // A live event or a retry asks for the same query again.
  const [asked, setAsked] = useState(0);
  const key = JSON.stringify([tenantId, tab, query]);

  useEffect(() => {
    if (!tenantId) return;
    let current = true;
    readAnalytics(tenantId, tab, query).then(
      (next) => {
        if (!current) return;
        setAnswer(next);
        setError(null);
        setLoadedKey(key);
      },
      (e: unknown) => {
        if (!current) return;
        setError(e);
        setLoadedKey(key);
      },
    );
    return () => {
      current = false;
    };
  }, [tenantId, tab, query, key, asked]);

  const reload = () => setAsked((n) => n + 1);
  useLiveReread(live.channels[0], live.types, reload, live.accepts);
  useLiveReread(live.channels[1], live.types, reload, live.accepts);

  return { answer, stale: answer !== null && loadedKey !== key, error, reload };
}
