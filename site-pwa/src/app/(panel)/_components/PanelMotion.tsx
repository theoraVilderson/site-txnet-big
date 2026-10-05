"use client";

import { MotionConfig } from "framer-motion";
import { useEffect } from "react";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION } from "@/lib/motion";

/**
 * The one motion switch (`contract.ux.md` M3). framer-motion gets it through
 * `<MotionConfig>`: at `reduced` transforms and layout animations are skipped
 * and anything left fades within `fast`. CSS gets it as `data-motion` on
 * `<html>`, which `MOTION_SCRIPT` already set before the first paint and this
 * keeps in step from then on.
 */
export function PanelMotion({ children }: { children: React.ReactNode }) {
  const level = useMotionLevel();

  useEffect(() => {
    const html = document.documentElement;
    if (level === "reduced") html.setAttribute("data-motion", "reduced");
    else html.removeAttribute("data-motion");
  }, [level]);

  return level === "reduced" ? (
    <MotionConfig reducedMotion="always" transition={{ duration: DURATION.fast }}>
      {children}
    </MotionConfig>
  ) : (
    <MotionConfig reducedMotion="never">{children}</MotionConfig>
  );
}
