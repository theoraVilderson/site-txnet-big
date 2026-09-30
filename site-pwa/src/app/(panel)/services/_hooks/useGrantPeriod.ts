"use client";

import { useEffect, useState } from "react";
import { billingApi, type GrantPeriodView } from "@/lib/billing-api";

/** Billing's answer and the lifetime total it was read against, for `livePeriodBytes`. */
export type PeriodRead = { view: GrantPeriodView; baseline: string };

/**
 * A metered Grant's billing period (F-118-aj over F-118-ai), read once when the
 * card mounts; `null` until it answers, and for good if it fails — the card
 * then says "no cap" with the lifetime total, which is still true. Pushed
 * bytes move the figure through `consumedBytes`, never a second read.
 */
export function useGrantPeriod(grantId: string, enabled: boolean, consumedBytes: string): PeriodRead | null {
  const [read, setRead] = useState<PeriodRead | null>(null);
  const [baselineAtAsk] = useState(consumedBytes);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    billingApi
      .grantPeriod(grantId)
      .then((view) => alive && setRead({ view, baseline: baselineAtAsk }))
      .catch(() => {
        /* the card keeps its lifetime total */
      });
    return () => {
      alive = false;
    };
  }, [grantId, enabled, baselineAtAsk]);

  return read;
}
