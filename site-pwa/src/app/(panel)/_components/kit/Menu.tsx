"use client";

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { cn } from "./cn";
import { useAnchoredPosition, useOutsidePointer, useOverlayLayer, type Align } from "./overlay";
import { withTrigger } from "./trigger";

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  /** `danger` for an action that destroys — it asks first, through `useConfirm` (K9). */
  tone?: "default" | "danger";
  disabled?: boolean;
}

export interface MenuProps {
  /** The menu's accessible name. */
  label: string;
  /** One element — usually an `IconButton` — that opens it. */
  trigger: ReactElement;
  items: readonly MenuItem[];
  align?: Align;
}

/**
 * A list of actions under a trigger (UX-1-d, `contract.ux.md` K7) — a table
 * row's actions (K13), a sidebar entry's pin. The WAI-ARIA menu button: the
 * arrows, Home and End move, Enter and Space run, Esc and Tab close, and focus
 * goes back to the trigger. The page is locked behind it like any overlay.
 */
export function Menu({ label, trigger, items, align = "end" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const id = useId();

  const button = withTrigger(trigger, triggerRef, {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
    },
  });

  return (
    <>
      {button}
      <AnimatePresence>
        {open && <MenuList key="menu" id={id} label={label} items={items} align={align} triggerRef={triggerRef} onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  );
}

function MenuList({
  id,
  label,
  items,
  align,
  triggerRef,
  onClose,
}: {
  id: string;
  label: string;
  items: readonly MenuItem[];
  align: Align;
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const level = useMotionLevel();
  const present = useIsPresent();
  const listRef = useRef<HTMLDivElement>(null);
  const { style, placedSide } = useAnchoredPosition(present, triggerRef, listRef, { align });
  useOverlayLayer({ active: present, containerRef: listRef, onClose, trap: false, returnFocusRef: triggerRef });
  useOutsidePointer(present, [listRef, triggerRef], onClose);

  const enabled = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);

  const run = (item: MenuItem) => {
    // Focus is home before the action runs, so a dialog the action opens
    // returns focus to the trigger when it closes in turn.
    triggerRef.current?.focus({ preventScroll: true });
    onClose();
    item.onSelect();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = enabled();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length].focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at < 0 ? list.length - 1 : at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(list.length - 1);
      case "Enter":
      case " ": {
        e.preventDefault();
        const item = items.find((i) => i.id === list[at]?.dataset.id);
        if (item) run(item);
        return;
      }
      case "Tab":
        e.preventDefault();
        onClose();
    }
  };

  const from = level === "reduced" ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: placedSide === "bottom" ? -4 : 4 };
  return createPortal(
    <motion.div
      ref={listRef}
      id={id}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={style}
      initial={from}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ ...from, transition: { duration: DURATION.fast, ease: EASE.exit } }}
      transition={{ duration: DURATION.fast, ease: EASE.standard }}
      className="fixed z-[60] min-w-44 rounded-2xl border border-card-border bg-card-bg p-1 shadow-[0_12px_32px_var(--card-shadow)] focus:outline-none"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-id={item.id}
          tabIndex={-1}
          disabled={item.disabled}
          onClick={() => run(item)}
          onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm transition-colors focus:outline-none disabled:opacity-50",
            item.tone === "danger" ? "text-error focus:bg-error-bg" : "text-text-primary focus:bg-leaf-bg",
          )}
        >
          {item.icon && <span className="shrink-0 [&>svg]:size-4">{item.icon}</span>}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </motion.div>,
    document.body,
  );
}
