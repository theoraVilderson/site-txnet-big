"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE, SHEET_SPRING } from "@/lib/motion";
import { Button } from "./Button";
import { notify } from "./notify";
import { useUnsavedGuard } from "./useUnsavedGuard";

const K = FrontendI18nKeys.common.kit.saveBar;

export interface SaveBarProps {
  dirty: boolean;
  /**
   * Saves. Resolving shows "Saved" as a toast; rejecting shows nothing here —
   * the form reports its own error inline (K4, K10) — and the bar stays.
   */
  onSave: () => Promise<unknown> | void;
  onDiscard: () => void;
  /** Save is off while the form is invalid. */
  disabled?: boolean;
  /** Replaces "Saved" in the toast. */
  savedMessage?: string;
}

/**
 * "Unsaved changes", Save and Discard, sliding up from the bottom while a form
 * is dirty (UX-1-e, `contract.ux.md` K11). It also guards the page: while it
 * shows, leaving asks first (`useUnsavedGuard`).
 */
export function SaveBar({ dirty, onSave, onDiscard, disabled, savedMessage }: SaveBarProps) {
  const { t } = useLocale();
  const level = useMotionLevel();
  const [saving, setSaving] = useState(false);
  useUnsavedGuard(dirty);

  const save = async () => {
    setSaving(true);
    try {
      await onSave();
      notify.success(savedMessage ?? t("common", K.saved));
    } catch {
      // The form's own error is already inline; the bar stays for a retry.
    } finally {
      setSaving(false);
    }
  };

  const away = level === "reduced" ? { opacity: 0 } : { opacity: 0, y: "120%" };
  return (
    <AnimatePresence>
      {dirty && (
        <motion.div
          key="save-bar"
          role="region"
          aria-label={t("common", K.unsaved)}
          initial={away}
          animate={{ opacity: 1, y: 0 }}
          exit={{ ...away, transition: { duration: DURATION.base, ease: EASE.exit } }}
          transition={level === "reduced" ? { duration: DURATION.fast } : SHEET_SPRING}
          className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          <div className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-2xl border border-card-border bg-card-bg p-2.5 ps-4 shadow-[0_12px_32px_var(--card-shadow)]">
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-bold text-text-primary">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
              <span role="status" className="truncate">
                {t("common", K.unsaved)}
              </span>
            </span>
            <Button variant="quiet" size="sm" onClick={onDiscard} disabled={saving}>
              {t("common", K.discard)}
            </Button>
            <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={disabled}>
              {t("common", K.save)}
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
