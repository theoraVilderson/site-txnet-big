"use client";

import { useCallback, useEffect, useState, type PointerEvent } from "react";
import { motion, useMotionTemplate, useMotionValue, useSpring } from "framer-motion";
import { RotateCcw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { IconButton } from "../kit";
import { BankCard } from "./BankCard";
import { bankColors, bankOfCard } from "./banks";
import { CopyButton } from "./CopyButton";
import type { DestinationProps } from "./transfer-kind";

const P = FrontendI18nKeys.common.transferPay.card;

/** The card leans at most this far toward the pointer or the phone's tilt (contract "Card-to-card"). */
const MAX_TILT_DEG = 8;
/** A phone's own lean (degrees) that gives the full tilt — a slight turn of the wrist, not a rotation. */
const GYRO_RANGE_DEG = 30;
/** How far back a phone in the hand usually leans; the card moves with the lean around it. */
const HELD_BETA_DEG = 45;
const TILT_SPRING = { stiffness: 220, damping: 22 };
/** Where the sheen rests (percent of the card) and how far it travels with a full lean. */
const SHEEN_REST = { x: 50, y: 30 };
const SHEEN_TRAVEL = 40;

/**
 * A card-to-card destination for its payer (F-803-i): the drawn card leaning
 * with the pointer or the phone, a moving sheen on it, and a tap that turns it
 * over to the holder's name and sheba, each copyable. Copy-number is the
 * primary button below it, and the holder's name is repeated in plain text,
 * because a payer should check it against the name their bank shows before
 * sending. Under reduced motion nothing leans or turns: the back fades in (M3).
 */
export function CardDestination({ destination }: DestinationProps) {
  const { t } = useLocale();
  const level = useMotionLevel();
  const [flipped, setFlipped] = useState(false);
  const digits = String(destination.cardNumber ?? "");
  const holder = String(destination.holderName ?? "");
  const sheba = destination.sheba ? String(destination.sheba) : null;
  const bankId = typeof destination.bankId === "string" ? destination.bankId : bankOfCard(digits);
  const tilt = useTilt(level === "full");

  const turn = level === "full" ? { rotateY: flipped ? 180 : 0 } : {};
  const face = (back: boolean) =>
    level === "full"
      ? { backfaceVisibility: "hidden" as const, transform: back ? "rotateY(180deg)" : undefined }
      : { opacity: flipped === back ? 1 : 0, transition: `opacity ${DURATION.fast}s` };

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-full max-w-sm [perspective:1000px]" onPointerMove={tilt.onPointerMove} onPointerLeave={tilt.reset}>
        <motion.div style={{ rotateX: tilt.x, rotateY: tilt.y, transformStyle: "preserve-3d" }}>
          <motion.div
            className="relative grid [transform-style:preserve-3d] [&>*]:[grid-area:1/1]"
            animate={turn}
            transition={{ duration: DURATION.slow * 2, ease: EASE.standard }}
          >
            <button
              type="button"
              onClick={() => setFlipped(true)}
              aria-label={t("common", P.flip)}
              aria-hidden={flipped}
              tabIndex={flipped ? -1 : 0}
              className="relative block w-full rounded-2xl text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              style={{ ...face(false), pointerEvents: flipped ? "none" : undefined }}
            >
              <BankCard digits={digits} holderName={holder} bankId={bankId} />
              {level === "full" && <motion.span aria-hidden className="pointer-events-none absolute inset-0 rounded-2xl" style={{ backgroundImage: tilt.sheen }} />}
            </button>
            <CardBack holder={holder} sheba={sheba} bankId={bankId} hidden={!flipped} style={face(true)} onFlipBack={() => setFlipped(false)} />
          </motion.div>
        </motion.div>
      </div>
      <p className="text-center text-xs text-text-secondary">{t("common", P.flip)}</p>
      <CopyButton value={digits} label={t("common", P.copyNumber)} copiedLabel={t("common", P.copied)} variant="primary" className="w-full max-w-sm" />
      <p className="max-w-sm text-center text-xs leading-5 text-text-secondary">{t("common", P.nameCheck, { name: holder })}</p>
    </div>
  );
}

function CardBack(props: { holder: string; sheba: string | null; bankId: string; hidden: boolean; style: React.CSSProperties; onFlipBack: () => void }) {
  const { t } = useLocale();
  const colors = bankColors(props.bankId);
  return (
    <div
      aria-hidden={props.hidden}
      className={`relative flex aspect-[856/540] w-full flex-col justify-between overflow-hidden rounded-2xl p-[6%] text-white shadow-lg ${colors ? "" : "bg-[image:var(--card-gradient)]"}`}
      // The bank's colours are its brand's data, as on the front (C-31 holds the panel's own).
      style={{ ...props.style, ...(colors ? { backgroundImage: `linear-gradient(135deg, ${colors[1]}, ${colors[0]})` } : {}), pointerEvents: props.hidden ? "none" : undefined }}
    >
      <div className="flex justify-end">
        <IconButton aria-label={t("common", P.flipBack)} icon={<RotateCcw size={16} aria-hidden />} onClick={props.onFlipBack} tabIndex={props.hidden ? -1 : 0} className="text-white hover:bg-white/15" />
      </div>
      <BackRow label={t("common", P.holder)} value={props.holder} hidden={props.hidden} />
      {props.sheba && <BackRow label={t("common", P.sheba)} value={props.sheba} hidden={props.hidden} ltr />}
    </div>
  );
}

function BackRow({ label, value, hidden, ltr }: { label: string; value: string; hidden: boolean; ltr?: boolean }) {
  const { t } = useLocale();
  return (
    <div className="flex items-end justify-between gap-2">
      <div className="min-w-0">
        <p className="text-3xs font-bold opacity-80">{label}</p>
        <p dir={ltr ? "ltr" : "auto"} className={`truncate text-sm font-bold ${ltr ? "font-mono" : ""}`}>
          {value}
        </p>
      </div>
      {!hidden && <CopyButton value={value} label={`${t("common", P.copy)} ${label}`} copiedLabel={t("common", P.copied)} iconOnly className="shrink-0 text-white hover:bg-white/15" />}
    </div>
  );
}

/**
 * The lean: toward the pointer over the card, or with the phone's own tilt
 * where the browser reports one. Off under reduced motion.
 */
function useTilt(on: boolean) {
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const x = useSpring(rawX, TILT_SPRING);
  const y = useSpring(rawY, TILT_SPRING);
  const glowX = useMotionValue(SHEEN_REST.x);
  const glowY = useMotionValue(SHEEN_REST.y);
  const sheen = useMotionTemplate`radial-gradient(circle at ${glowX}% ${glowY}%, rgb(255 255 255 / 0.28), transparent 55%)`;

  // fx, fy in -1..1 from the card's centre; the sheen follows the light source opposite the lean.
  const lean = useCallback(
    (fx: number, fy: number) => {
      rawX.set(-fy * MAX_TILT_DEG);
      rawY.set(fx * MAX_TILT_DEG);
      glowX.set(SHEEN_REST.x + fx * SHEEN_TRAVEL);
      glowY.set(SHEEN_REST.y + fy * SHEEN_TRAVEL);
    },
    [rawX, rawY, glowX, glowY],
  );
  const reset = () => lean(0, 0);

  useEffect(() => {
    if (!on || typeof window === "undefined") return;
    const orient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      const clampUnit = (v: number) => Math.max(-1, Math.min(1, v / GYRO_RANGE_DEG));
      lean(clampUnit(e.gamma), clampUnit(e.beta - HELD_BETA_DEG));
    };
    window.addEventListener("deviceorientation", orient);
    return () => window.removeEventListener("deviceorientation", orient);
  }, [on, lean]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!on || e.pointerType !== "mouse") return;
    const box = e.currentTarget.getBoundingClientRect();
    lean(((e.clientX - box.left) / box.width) * 2 - 1, ((e.clientY - box.top) / box.height) * 2 - 1);
  };

  return { x, y, sheen, onPointerMove, reset };
}
