"use client";

import { useEffect, useState } from "react";

/**
 * `true` on the *first* client render in this browser tab's lifetime, `false`
 * ever after.
 *
 * Why: framer-motion enter animations that start at `opacity:0` keep the SSR
 * content invisible until hydration and the animation finish. With
 * `initial={useFirstPaint() ? false : {...}}` the animation is skipped on the
 * page's first load only (content shows at once), while client-side
 * navigation after hydration still animates.
 *
 * The flag is module-level and set only inside an effect, so every caller in
 * one render gets the same value.
 */
let paintedOnce = false;

export function useFirstPaint(): boolean {
  const [first] = useState(() => !paintedOnce);
  useEffect(() => {
    paintedOnce = true;
  }, []);
  return first;
}
