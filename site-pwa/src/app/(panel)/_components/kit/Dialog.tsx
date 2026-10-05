"use client";

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { X } from "lucide-react";
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { IconButton } from "./Button";
import { cn } from "./cn";
import { useOverlayLayer } from "./overlay";

const K = FrontendI18nKeys.common.kit;

const WIDTH = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl" } as const;

export interface DialogProps {
  open: boolean;
  /** Esc, the backdrop and the close button all call this; the caller decides (a dirty form asks, K9). */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: keyof typeof WIDTH;
  /** Buttons at the bottom, end-aligned; they stay in view while the body scrolls. */
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Hides the X — for a question that has its own answers (`useConfirm`). */
  hideClose?: boolean;
  /** `alertdialog` for a warning that interrupts and waits for an answer. */
  role?: "dialog" | "alertdialog";
  className?: string;
  children?: ReactNode;
}

/**
 * A modal dialog (UX-1-d, `contract.ux.md` K7): focus trapped and returned,
 * the page locked, Esc and the backdrop close, in and out through
 * `AnimatePresence`. Centred from `sm` up; below it, at the bottom of the screen
 * where a thumb reaches.
 */
export function Dialog(props: DialogProps) {
  return <AnimatePresence>{props.open && <DialogLayer key="dialog" {...props} />}</AnimatePresence>;
}

function DialogLayer({ onClose, title, description, size = "md", footer, initialFocusRef, hideClose, role = "dialog", className, children }: DialogProps) {
  const { t } = useLocale();
  const level = useMotionLevel();
  const present = useIsPresent();
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useOverlayLayer({ active: present, containerRef: panelRef, onClose, initialFocusRef });

  const enter = level === "reduced" ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: DURATION.base, ease: EASE.exit } }}
        transition={{ duration: DURATION.base }}
        onClick={onClose}
      />
      <motion.div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        initial={enter}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ ...enter, transition: { duration: DURATION.base, ease: EASE.exit } }}
        transition={{ duration: DURATION.slow, ease: EASE.standard }}
        className={cn(
          "relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl border border-card-border bg-card-bg shadow-2xl focus:outline-none sm:rounded-3xl",
          WIDTH[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-lg font-bold text-text-primary">
              {title}
            </h2>
            {description && (
              <p id={`${id}-desc`} className="mt-1 text-sm text-text-secondary">
                {description}
              </p>
            )}
          </div>
          {!hideClose && <IconButton aria-label={t("common", K.dialog.close)} icon={<X size={18} aria-hidden />} size="sm" onClick={onClose} className="-me-1.5 -mt-1" />}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-card-border px-5 py-3.5">{footer}</div>}
      </motion.div>
    </div>,
    document.body,
  );
}
