"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const F = FrontendI18nKeys.common.financial;

export interface ExpandableRowProps {
  expanded: boolean;
  onToggle: () => void;
  /** A row with nothing more to say does not pretend to open. */
  canExpand: boolean;
  /** The always-visible line. Owns its own grid. */
  children: ReactNode;
  /** Rendered only while open. */
  details: ReactNode;
}

/**
 * The accordion both lists' rows are built on (F-093-d).
 *
 * A `div` with `role="button"` rather than a real one, because the summary
 * holds its own copy button and a button inside a button is invalid markup
 * that browsers resolve by dropping one of them. The keyboard handler is what
 * a real button would have given for free, so it is not optional: legacy's row
 * was a bare `onClick` and could not be opened without a mouse at all.
 */
export function ExpandableRow({ expanded, onToggle, canExpand, children, details }: ExpandableRowProps) {
  const { t } = useLocale();

  const interactive = canExpand
    ? {
        role: "button",
        tabIndex: 0,
        "aria-expanded": expanded,
        "aria-label": t("common", expanded ? F.collapse : F.expand),
        onClick: onToggle,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        },
      }
    : {};

  return (
    <div className="border-b border-card-border last:border-0">
      <div
        {...interactive}
        className={`relative px-4 py-3 transition-colors md:px-6 ${
          canExpand ? "cursor-pointer hover:bg-leaf-bg/40 focus-visible:bg-leaf-bg/40" : ""
        } ${expanded ? "bg-leaf-bg/30" : ""}`}
      >
        {/* The open row's marker sits on the inline start, so it follows the script. */}
        <span
          aria-hidden
          className={`absolute inset-y-0 start-0 w-1 transition-colors ${expanded ? "bg-primary" : "bg-transparent"}`}
        />
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">{children}</div>
          {canExpand && (
            <ChevronDown
              size={18}
              aria-hidden
              className={`shrink-0 text-text-secondary transition-transform duration-300 ${
                expanded ? "rotate-180 text-primary" : ""
              }`}
            />
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden border-t border-card-border bg-bg-inner"
          >
            <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4 md:p-6">{details}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
