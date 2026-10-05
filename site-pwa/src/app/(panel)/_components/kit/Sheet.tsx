"use client";

import { AnimatePresence, motion, useDragControls, useIsPresent, type PanInfo } from "framer-motion";
import { X } from "lucide-react";
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE, SHEET_SPRING } from "@/lib/motion";
import { IconButton } from "./Button";
import { cn } from "./cn";
import { MD_UP, useMediaQuery, useOverlayLayer } from "./overlay";

const K = FrontendI18nKeys.common.kit;

/** A drag down past this, or flung faster than the speed below, closes the bottom sheet. */
const CLOSE_OFFSET_PX = 120;
const CLOSE_VELOCITY = 600;

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** The side panel's width from `md` up. */
  width?: "md" | "lg" | "xl";
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  children?: ReactNode;
}

const WIDTH = { md: "md:w-[28rem]", lg: "md:w-[36rem]", xl: "md:w-[48rem]" } as const;

/**
 * A panel from the end side from `md` up, and a bottom sheet below it that a
 * drag on its handle pulls closed (UX-1-d, `contract.ux.md` K7). Everything a
 * `Dialog` holds — trap, lock, Esc, backdrop, focus return — holds here.
 */
export function Sheet(props: SheetProps) {
  return <AnimatePresence>{props.open && <SheetLayer key="sheet" {...props} />}</AnimatePresence>;
}

function SheetLayer({ onClose, title, description, footer, width = "md", initialFocusRef, className, children }: SheetProps) {
  const { t } = useLocale();
  const level = useMotionLevel();
  const present = useIsPresent();
  const side = useMediaQuery(MD_UP);
  const drag = useDragControls();
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useOverlayLayer({ active: present, containerRef: panelRef, onClose, initialFocusRef });

  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const away = side ? { x: rtl ? "-100%" : "100%" } : { y: "100%" };
  const hidden = level === "reduced" ? { opacity: 0 } : away;
  const shown = level === "reduced" ? { opacity: 1 } : { x: 0, y: 0 };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > CLOSE_OFFSET_PX || info.velocity.y > CLOSE_VELOCITY) onClose();
  };

  return createPortal(
    <div className={cn("fixed inset-0 z-50 flex", side ? "justify-end" : "items-end")}>
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        initial={hidden}
        animate={shown}
        exit={{ ...hidden, transition: { duration: DURATION.slow, ease: EASE.exit } }}
        transition={level === "reduced" ? { duration: DURATION.fast } : SHEET_SPRING}
        drag={side ? false : "y"}
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 1 }}
        onDragEnd={onDragEnd}
        className={cn(
          "relative flex w-full flex-col border-card-border bg-card-bg shadow-2xl focus:outline-none",
          side ? cn("h-full border-s", WIDTH[width]) : "max-h-[92dvh] rounded-t-3xl border-t",
          className,
        )}
      >
        {!side && (
          <div
            className="flex shrink-0 cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
            onPointerDown={(e) => drag.start(e)}
            aria-hidden
          >
            <span className="h-1.5 w-10 rounded-full bg-card-border" />
          </div>
        )}
        <div className={cn("flex items-start justify-between gap-3 px-5", side ? "pt-5" : "pt-2")}>
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
          <IconButton aria-label={t("common", K.dialog.close)} icon={<X size={18} aria-hidden />} size="sm" onClick={onClose} className="-me-1.5 -mt-1" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-card-border px-5 py-3.5">{footer}</div>}
      </motion.div>
    </div>,
    document.body,
  );
}
