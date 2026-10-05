"use client";

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { cn } from "./cn";
import { useAnchoredPosition, useOutsidePointer, useOverlayLayer, type Align, type Side } from "./overlay";
import { withTrigger } from "./trigger";

export interface PopoverProps {
  /** The panel's accessible name. */
  label: string;
  trigger: ReactElement;
  /** Content, or a function of `close` for content that closes itself. */
  children: ReactNode | ((close: () => void) => ReactNode);
  side?: Side;
  align?: Align;
  className?: string;
  /** Controlled use — the sidebar's collapsed flyout (N3). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A small non-modal panel beside its trigger (UX-1-d, `contract.ux.md` K7):
 * focus moves in and Tab stays inside, Esc or a click outside closes, focus
 * returns to the trigger.
 */
export function Popover({ label, trigger, children, side = "bottom", align = "start", className, open: controlled, onOpenChange }: PopoverProps) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => {
    if (controlled === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  const triggerRef = useRef<HTMLElement | null>(null);
  const id = useId();

  const button = withTrigger(trigger, triggerRef, {
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    onClick: () => setOpen(!open),
  });

  return (
    <>
      {button}
      <AnimatePresence>
        {open && (
          <PopoverPanel key="popover" id={id} label={label} side={side} align={align} triggerRef={triggerRef} onClose={() => setOpen(false)} className={className}>
            {typeof children === "function" ? children(() => setOpen(false)) : children}
          </PopoverPanel>
        )}
      </AnimatePresence>
    </>
  );
}

function PopoverPanel({
  id,
  label,
  side,
  align,
  triggerRef,
  onClose,
  className,
  children,
}: {
  id: string;
  label: string;
  side: Side;
  align: Align;
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const level = useMotionLevel();
  const present = useIsPresent();
  const panelRef = useRef<HTMLDivElement>(null);
  const { style, placedSide } = useAnchoredPosition(present, triggerRef, panelRef, { side, align });
  useOverlayLayer({ active: present, containerRef: panelRef, onClose });
  useOutsidePointer(present, [panelRef, triggerRef], onClose);

  const from = level === "reduced" ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: placedSide === "bottom" ? -4 : 4 };
  return createPortal(
    <motion.div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={style}
      initial={from}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ ...from, transition: { duration: DURATION.fast, ease: EASE.exit } }}
      transition={{ duration: DURATION.base, ease: EASE.standard }}
      className={cn("fixed z-[60] max-w-[calc(100vw-1rem)] rounded-2xl border border-card-border bg-card-bg p-3 shadow-[0_12px_32px_var(--card-shadow)] focus:outline-none", className)}
    >
      {children}
    </motion.div>,
    document.body,
  );
}
