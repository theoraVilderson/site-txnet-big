"use client";

import { motion } from "framer-motion";
import { useLocale } from "@/context/LocaleContext";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import type { ResellerOnboarding } from "@/lib/tenant-onboarding-api";
import { ONBOARDING_KEYS as K } from "../../_lib/onboarding";
import { requiredCount } from "../../_lib/setup";

/** Required steps done of all of them — one bar for the home (UX-2-b) and the wizard (UX-2-c); an optional step counts toward neither (F-213). */
export function SetupProgress({ view }: { view: ResellerOnboarding }) {
  const { t } = useLocale();
  const reduced = useMotionLevel() === "reduced";
  const { done, total } = requiredCount(view);
  if (total === 0) return null;
  const label = t("common", K.progress, { done, total });
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <div
        className="h-2 overflow-hidden rounded-full bg-leaf-bg"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <motion.div
          className="h-full rounded-full bg-primary"
          initial={false}
          animate={{ width: `${(done / total) * 100}%` }}
          transition={{ duration: reduced ? 0 : DURATION.slow, ease: EASE.standard }}
        />
      </div>
    </div>
  );
}
