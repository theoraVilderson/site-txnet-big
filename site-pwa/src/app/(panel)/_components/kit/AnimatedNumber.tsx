"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useMotionLevel } from "@/hooks/useMotionLevel";

const COUNT_MS = 600;

export interface AnimatedNumberProps {
  value: number;
  /** How a number is written — digits, a currency. The final frame is exactly `format(value)`. */
  format: (n: number) => string;
  className?: string;
}

/**
 * A figure that counts up from zero the first time it is drawn (UX-1-c,
 * `contract.ux.md` K6), then simply shows each new value: a balance that
 * re-counts on every refresh would read as a change.
 *
 * Only the eye sees the count. A screen reader is given the final value from
 * the first frame, and at the `reduced` motion level there is no count at all
 * (M3).
 */
export function AnimatedNumber({ value, format, className }: AnimatedNumberProps) {
  const level = useMotionLevel();
  const counted = useRef(false);
  const [shown, setShown] = useState<number | null>(null);

  // A layout effect, so the first paint is already at zero rather than a frame
  // of the final value. `counted` turns only when a count finishes: a count cut
  // short (a new value, StrictMode's double run) starts again.
  useLayoutEffect(() => {
    if (counted.current || level === "reduced" || value === 0 || typeof requestAnimationFrame === "undefined") {
      counted.current = true;
      setShown(null);
      return;
    }
    setShown(0);
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / COUNT_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p < 1) {
        setShown(value * eased);
        frame = requestAnimationFrame(tick);
      } else {
        counted.current = true;
        setShown(null);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, level]);

  return (
    <span className={className}>
      <span aria-hidden className="tabular-nums">
        {format(shown ?? value)}
      </span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
