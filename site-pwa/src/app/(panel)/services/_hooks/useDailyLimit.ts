"use client";

import { useEffect, useState } from "react";

/** A per-day cap's refusal: how many a day, and when the next is allowed — an ISO instant. */
export interface DailyLimit {
  limit: number;
  nextAt: string;
}

/**
 * A per-day cap's refusal, held until the time it named and then let go, no
 * reload (F-114-e-d's link reset, F-0401-e's freeze). Billing still decides:
 * an act too early is refused the same way, so this only spares the user a
 * button that cannot work yet.
 */
export function useDailyLimit(): [DailyLimit | null, (limit: DailyLimit | null) => void] {
  const [limited, setLimited] = useState<DailyLimit | null>(null);
  useEffect(() => {
    if (!limited) return;
    const wait = Date.parse(limited.nextAt) - Date.now();
    const timer = setTimeout(() => setLimited(null), Math.max(0, Math.min(wait, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [limited]);
  return [limited, setLimited];
}
