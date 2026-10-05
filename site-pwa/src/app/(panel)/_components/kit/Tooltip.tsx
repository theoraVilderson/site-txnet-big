"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DURATION } from "@/lib/motion";
import { useAnchoredPosition, type Align, type Side } from "./overlay";
import { withTrigger } from "./trigger";

/** Hover waits this long, so a pointer crossing the page does not flash every tooltip; focus does not wait. */
const HOVER_DELAY_MS = 400;

export interface TooltipProps {
  content: ReactNode;
  /** One element that can take focus. */
  children: ReactElement;
  side?: Side;
  align?: Align;
}

/**
 * A short label for a control, on hover and on keyboard focus (UX-1-d,
 * `contract.ux.md` K7). It describes its trigger (`aria-describedby`) while
 * shown and closes on Esc. It holds no focus, so it neither traps nor locks.
 */
export function Tooltip({ content, children, side = "top", align = "center" }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const { style } = useAnchoredPosition(open, triggerRef, tipRef, { side, align });

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (delay: number) => {
    clear();
    if (delay === 0) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => clear, []);

  const trigger = withTrigger(children, triggerRef, {
    "aria-describedby": open ? id : undefined,
    onMouseEnter: () => show(HOVER_DELAY_MS),
    onMouseLeave: hide,
    onFocus: () => show(0),
    onBlur: hide,
  });

  return (
    <>
      {trigger}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={tipRef}
                id={id}
                role="tooltip"
                style={style}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DURATION.fast }}
                className="pointer-events-none fixed z-[80] max-w-xs rounded-lg bg-text-primary px-2.5 py-1.5 text-xs font-medium text-card-bg shadow-lg"
              >
                {content}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
