"use client";

import { motion } from "framer-motion";
import { useLocale } from "@/context/LocaleContext";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { PAY_KEYS, type Countdown } from "../_lib/transfer-page";

const SIZE = 112;
const STROKE = 8;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const MS_PER_MINUTE = 60_000;

const TONE: Record<Countdown["tone"] | "credited", string> = {
  normal: "text-primary",
  warning: "text-warning",
  over: "text-error",
  credited: "text-success",
};

/** `mm:ss` of what is left; hours fold into minutes — a window is at most a day. */
function clock(leftMs: number): string {
  const total = Math.ceil(leftMs / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The payer's window as a ring (contract "Countdown"): the share of the
 * gateway's window left, green until five minutes remain, then the `warning`
 * tone. Credited, it fills to a full circle with a check drawn inside.
 */
export function CountdownRing({ countdown, credited }: { countdown: Countdown; credited?: boolean }) {
  const { t } = useLocale();
  const level = useMotionLevel();
  const tone = credited ? "credited" : countdown.tone;
  const fraction = credited ? 1 : countdown.fraction;
  const ease = { duration: level === "full" ? DURATION.slow : DURATION.fast, ease: EASE.standard };

  return (
    <div className={`relative grid place-items-center ${TONE[tone]}`} style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} className="-rotate-90" aria-hidden>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-card-border" />
        <motion.circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          initial={false}
          animate={{ strokeDashoffset: CIRCUMFERENCE * (1 - fraction) }}
          transition={ease}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        {credited ? (
          <svg viewBox="0 0 24 24" className="size-10" aria-hidden>
            <motion.path
              d="M5 12.5l4.5 4.5L19 7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={level === "full" ? { pathLength: 0 } : { opacity: 0 }}
              animate={level === "full" ? { pathLength: 1 } : { opacity: 1 }}
              transition={{ ...ease, delay: level === "full" ? DURATION.slow : 0 }}
            />
          </svg>
        ) : (
          <span className="flex flex-col items-center" role="timer" aria-label={t("common", PAY_KEYS.countdown.label)}>
            <span dir="ltr" className="font-mono text-xl font-bold">
              {clock(countdown.leftMs)}
            </span>
            <span className="sr-only">{t("common", PAY_KEYS.countdown.minutes, { time: String(Math.ceil(countdown.leftMs / MS_PER_MINUTE)) })}</span>
          </span>
        )}
      </div>
    </div>
  );
}
