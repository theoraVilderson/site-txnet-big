import type { Variants } from "framer-motion";
import { MARKER_STORAGE_KEY, MINI_APP_PARAM, MINI_APP_SDK } from "./mini-app";

/**
 * The panel's motion (UX-1-b, `panel-web/contract.ux.md` M1–M3): one set of
 * timings, two levels, one switch.
 *
 * The level is applied in two places that must agree: `<MotionConfig>` at the
 * panel layout (`PanelMotion`) for framer-motion, and `data-motion="reduced"`
 * on `<html>` for every CSS keyframe in `globals.css` and Tailwind's
 * `motion-reduce:` / `motion-safe:` variants. Nothing reads
 * `prefers-reduced-motion` on its own any more: the OS is one input to the
 * level, and from UX-1-l the person's `ui.motion` outranks it.
 */

export type MotionLevel = "full" | "reduced";
export type MotionPreference = "system" | MotionLevel;

/** Seconds, as framer-motion takes them: hover/press, fades/tabs, sheets/dialogs. */
export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const;

export const EASE = {
  standard: [0.2, 0.8, 0.2, 1],
  exit: [0.4, 0, 1, 1],
} as const;

export const SHEET_SPRING = { type: "spring", stiffness: 380, damping: 34 } as const;

const STAGGER_STEP = 0.04;
const STAGGER_MAX = 8;

/** Reduced is opacity only, never longer than `fast` (M3). */
const FADE: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: DURATION.fast } },
};

/** A page or a block entering: up 8px and in. */
export function fadeRise(level: MotionLevel): Variants {
  if (level === "reduced") return FADE;
  return {
    hidden: { opacity: 0, y: 8 },
    shown: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE.standard } },
  };
}

/** Something small arriving — a badge, a check, a prize. */
export function pop(level: MotionLevel): Variants {
  if (level === "reduced") return FADE;
  return {
    hidden: { opacity: 0, scale: 0.9 },
    shown: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 520, damping: 28 } },
  };
}

/**
 * A list child's delay: 40ms apart for the first 8, and the rest together with
 * the 8th, so a long list never makes its tail wait.
 */
export function staggerDelay(index: number, level: MotionLevel): number {
  if (level === "reduced") return 0;
  return Math.round(Math.min(index, STAGGER_MAX - 1) * STAGGER_STEP * 100) / 100;
}

export type MotionInputs = {
  preference: MotionPreference;
  osReduced: boolean;
  /** Running inside the Telegram or Bale Mini App (`lib/mini-app.ts`). */
  miniApp: boolean;
  /** `navigator.hardwareConcurrency`; absent where the browser does not say. */
  cores?: number;
  /** `navigator.deviceMemory` in GB; Chromium only. */
  memoryGb?: number;
};

/**
 * M2: the person's choice, else the OS, else — inside the Mini App only — a
 * weak device. A browser that does not report its device is not weak.
 */
export function resolveMotionLevel(input: MotionInputs): MotionLevel {
  if (input.preference !== "system") return input.preference;
  if (input.osReduced) return "reduced";
  const weak =
    (input.cores !== undefined && input.cores <= 4) ||
    (input.memoryGb !== undefined && input.memoryGb <= 2);
  return input.miniApp && weak ? "reduced" : "full";
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Sets the switch before the first paint, as `THEME_SCRIPT` does the theme, so
 * a CSS entrance on the first screen never runs for a frame first. It knows the
 * OS and the device, not the person's choice — `PanelMotion` corrects that once
 * the preferences load. The Mini App marker is `lib/mini-app.ts`'s: the `ma`
 * query parameter or its `sessionStorage` copy.
 */
export const MOTION_SCRIPT = `
(function () {
  try {
    var os = window.matchMedia && window.matchMedia('${REDUCED_MOTION_QUERY}').matches;
    var ps = ${JSON.stringify(Object.keys(MINI_APP_SDK))};
    var ma = ps.indexOf(new URLSearchParams(window.location.search).get('${MINI_APP_PARAM}')) >= 0;
    if (!ma) { try { ma = ps.indexOf(window.sessionStorage.getItem('${MARKER_STORAGE_KEY}')) >= 0; } catch (e) {} }
    var n = window.navigator || {};
    var weak = (n.hardwareConcurrency !== undefined && n.hardwareConcurrency <= 4) ||
      (n.deviceMemory !== undefined && n.deviceMemory <= 2);
    if (os || (ma && weak)) document.documentElement.setAttribute('data-motion', 'reduced');
  } catch (e) {}
})();
`;
