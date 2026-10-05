"use client";

import { useSyncExternalStore } from "react";
import { miniAppPlatform } from "@/lib/mini-app";
import { REDUCED_MOTION_QUERY, resolveMotionLevel, type MotionLevel } from "@/lib/motion";
import { useUiPreferences } from "@/stores/ui-preferences-store";

/**
 * The panel's motion level (`contract.ux.md` M2), live: it follows the OS
 * setting and the person's own `ui.motion` (UX-1-l) as either changes. A
 * component that animates asks this, not
 * framer-motion's `useReducedMotion`, which knows only the OS.
 */
export function useMotionLevel(): MotionLevel {
  return useSyncExternalStore(subscribe, snapshot, () => "full");
}

function subscribe(onChange: () => void): () => void {
  const offPreference = useUiPreferences.subscribe((s, prev) => {
    if (s.prefs["ui.motion"] !== prev.prefs["ui.motion"]) onChange();
  });
  if (typeof window === "undefined" || !window.matchMedia) return offPreference;
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", onChange);
  return () => {
    offPreference();
    mql.removeEventListener("change", onChange);
  };
}

function snapshot(): MotionLevel {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return resolveMotionLevel({
    preference: useUiPreferences.getState().prefs["ui.motion"],
    osReduced: !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches,
    miniApp: miniAppPlatform() !== null,
    cores: nav.hardwareConcurrency,
    memoryGb: nav.deviceMemory,
  });
}
