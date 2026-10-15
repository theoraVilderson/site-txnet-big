"use client";

import { useEffect, useState } from "react";

const TICK_MS = 1000;

/** The wall clock, once a second while `ticking` — the countdown's, not a read of anything (C-14). */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
