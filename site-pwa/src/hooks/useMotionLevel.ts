"use client";

import { useSyncExternalStore } from "react";
import { miniAppPlatform } from "@/lib/mini-app";
import { REDUCED_MOTION_QUERY, resolveMotionLevel, type MotionLevel } from "@/lib/motion";

/**
 * The panel's motion level (`contract.ux.md` M2), live: it follows the OS
 * setting as it changes. The person's own `ui.motion` joins the inputs in
 * UX-1-l; until then it is `system`. A component that animates asks this, not
 * framer-motion's `useReducedMotion`, which knows only the OS.
 */
export function useMotionLevel(): MotionLevel {
  return useSyncExternalStore(subscribe, snapshot, () => "full");
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function snapshot(): MotionLevel {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return resolveMotionLevel({
    preference: "system",
    osReduced: !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches,
    miniApp: miniAppPlatform() !== null,
    cores: nav.hardwareConcurrency,
    memoryGb: nav.deviceMemory,
  });
}
