"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { SYSTEMS_KEYS as K } from "../_lib/systems";
import { RegisterWizard } from "./RegisterWizard";

/**
 * Registering a panel (F-027-ar's route), walked in `RegisterWizard`
 * (F-027-bq). A desired-state write and nothing more: the answer is always
 * `pending`, and the connection test on the next tick answers the
 * questionnaire and accepts or refuses the panel — here, never at billing
 * time. The login goes to the vault and is not kept after the call.
 *
 * The page's header button (F-027-ck); the guide's first step opens the same
 * wizard, so `open` is the page's.
 */
export function RegisterPanel({
  open,
  onOpen,
  onClose,
  onRegistered,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRegistered: () => Promise<void>;
}) {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();

  return (
    <>
      <motion.button
        type="button"
        onClick={onOpen}
        whileHover={reduceMotion ? undefined : { y: -1 }}
        whileTap={reduceMotion ? undefined : { scale: 0.96 }}
        className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent shadow-md hover:brightness-110"
      >
        <Plus size={14} aria-hidden />
        {t("common", K.register.open)}
      </motion.button>
      <AnimatePresence>{open && <RegisterWizard onClose={onClose} onRegistered={onRegistered} />}</AnimatePresence>
    </>
  );
}
