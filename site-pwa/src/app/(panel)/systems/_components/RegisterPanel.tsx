"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Boxes, KeyRound, ListChecks, Plug, Plus, Tag } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { SYSTEMS_KEYS as K } from "../_lib/systems";
import { Section } from "./parts";
import { RegisterWizard } from "./RegisterWizard";

const PREVIEW = [Boxes, Tag, Plug, KeyRound, ListChecks];

/**
 * Registering a panel (F-027-ar's route), walked in `RegisterWizard`
 * (F-027-bq). A desired-state write and nothing more: the answer is always
 * `pending`, and the connection test on the next tick answers the
 * questionnaire and accepts or refuses the panel — here, never at billing
 * time. The login goes to the vault and is not kept after the call.
 */
export function RegisterPanel({ onRegistered }: { onRegistered: () => Promise<void> }) {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);

  return (
    <Section
      title={t("common", K.register.title)}
      hint={t("common", K.register.hint)}
      actions={
        <motion.button
          type="button"
          onClick={() => setOpen(true)}
          whileHover={reduceMotion ? undefined : { y: -1 }}
          whileTap={reduceMotion ? undefined : { scale: 0.96 }}
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent shadow-md hover:brightness-110"
        >
          <Plus size={14} aria-hidden />
          {t("common", K.register.open)}
        </motion.button>
      }
    >
      {/* The five steps at a glance, so the operator knows the walk before starting it. */}
      <ol className="flex flex-wrap items-center gap-1.5" aria-hidden>
        {PREVIEW.map((Icon, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <motion.span
              initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: reduceMotion ? 0 : i * 0.06, type: "spring", stiffness: 400, damping: 22 }}
              className="grid size-7 place-items-center rounded-full bg-[var(--leaf-bg)] text-primary"
            >
              <Icon size={13} />
            </motion.span>
            {i < PREVIEW.length - 1 && <span className="h-px w-4 bg-card-border" />}
          </li>
        ))}
      </ol>
      <AnimatePresence>{open && <RegisterWizard onClose={() => setOpen(false)} onRegistered={onRegistered} />}</AnimatePresence>
    </Section>
  );
}
