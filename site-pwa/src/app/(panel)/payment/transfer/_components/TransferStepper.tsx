"use client";

import { motion } from "framer-motion";
import { useLocale } from "@/context/LocaleContext";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { PAY_KEYS, STEPS } from "../_lib/transfer-page";

/** The track runs from the first dot's centre to the last's: an eighth in from each side of four columns. */
const TRACK_SPAN_PCT = 75;

/**
 * `send` → `proof` → `checking` → `credited` (contract "The pay page"): the
 * active step's dot fills, the line between steps grows to it, and a step done
 * draws its check. Under reduced motion each change is a short fade (M3).
 */
export function TransferStepper({ active }: { active: number }) {
  const { t } = useLocale();
  const level = useMotionLevel();
  const full = level === "full";
  const grow = full ? { duration: DURATION.slow, ease: EASE.standard } : { duration: 0 };

  return (
    <ol className="relative grid grid-cols-4" aria-label={t("common", PAY_KEYS.title)}>
      <span aria-hidden className="absolute inset-x-[12.5%] top-3 h-0.5 rounded-full bg-card-border" />
      <motion.span
        aria-hidden
        className="absolute start-[12.5%] top-3 h-0.5 rounded-full bg-primary"
        initial={false}
        animate={{ width: `${(Math.min(active, STEPS.length - 1) / (STEPS.length - 1)) * TRACK_SPAN_PCT}%` }}
        transition={grow}
      />
      {STEPS.map((step, i) => {
        const done = i < active || (i === active && step === "credited");
        const current = i === active;
        return (
          <li key={step} className="relative flex flex-col items-center gap-1.5" aria-current={current ? "step" : undefined}>
            <span
              className={`grid size-6 place-items-center rounded-full border-2 transition-colors ${
                done || current ? "border-primary bg-primary text-on-accent" : "border-card-border bg-card-bg"
              }`}
            >
              {done ? (
                <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                  <motion.path
                    d="M3 8.5l3 3 7-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={full ? { pathLength: 0 } : { opacity: 0 }}
                    animate={full ? { pathLength: 1 } : { opacity: 1 }}
                    transition={{ duration: full ? DURATION.base : DURATION.fast }}
                  />
                </svg>
              ) : (
                current && <span className="size-2 rounded-full bg-on-accent" />
              )}
            </span>
            <span className={`text-3xs font-bold ${current ? "text-text-primary" : "text-text-secondary"}`}>{t("common", PAY_KEYS.steps[step])}</span>
          </li>
        );
      })}
    </ol>
  );
}
