"use client";

import { useEffect, useState } from "react";
import { timeLeft } from "../_lib/usage";

/**
 * A Grant's time left, recounted in the browser each time the minute it shows
 * changes (F-307-s). The next count is timed to the Grant's own end, not the
 * wall clock's minute, so the figure turns exactly when it should. It asks
 * billing nothing — the period is on the row (contract.my-services.md rule 13).
 * A Grant with no end, or one already ended, keeps no timer.
 */
export function useTimeLeft(startsAt: string, endsAt: string | null) {
  const [now, setNow] = useState(() => new Date());
  const left = timeLeft(startsAt, endsAt, now);
  const ticking = left !== null && left.spent < 1;

  useEffect(() => {
    if (!ticking || !endsAt) return;
    const untilNext = (new Date(endsAt).getTime() - now.getTime()) % 60_000 || 60_000;
    const timer = setTimeout(() => setNow(new Date()), untilNext);
    return () => clearTimeout(timer);
  }, [ticking, endsAt, now]);

  return left;
}
