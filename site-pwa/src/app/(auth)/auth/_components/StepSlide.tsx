"use client";

import { motion } from "framer-motion";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";

/** How a form step slides in from the reading side — one motion for every auth screen. */
const SLIDE_PX = 30;
const SLIDE_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * One step of an auth form, sliding in from the side the text is read from.
 * `still` skips the entrance on the screen's first paint, which would
 * otherwise animate a form the visitor has not asked to change.
 */
export function StepSlide({ still, children }: { still: boolean; children: React.ReactNode }) {
  const { isRtl } = useAuthUI();
  return (
    <motion.div
      initial={still ? false : { opacity: 0, x: isRtl ? -SLIDE_PX : SLIDE_PX, filter: "blur(5px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, x: isRtl ? SLIDE_PX : -SLIDE_PX, filter: "blur(5px)" }}
      transition={{ duration: 0.4, ease: SLIDE_EASE }}
    >
      {children}
    </motion.div>
  );
}
