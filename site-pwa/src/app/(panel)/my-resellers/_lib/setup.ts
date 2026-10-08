import { Bot, Globe, Landmark, Package, type LucideIcon } from "lucide-react";
import type { MotionLevel } from "@/lib/motion";
import type { OnboardingStepKey, ResellerOnboarding } from "@/lib/tenant-api";

/** Each onboarding step's icon in the setup wizard's rail (UX-2-c). */
export const SETUP_STEP_ICONS: Record<OnboardingStepKey, LucideIcon> = {
  domain: Globe,
  gateway: Landmark,
  bot: Bot,
  pricing: Package,
};

/**
 * Where the wizard opens: the first step the route says is not done, in the
 * route's own order (F-213). "Later" is not stored (user, 2026-10-08) — the
 * checklist is, live, so it already says where to resume. All done: the first,
 * behind the finished screen.
 */
export function firstUndoneIndex(steps: ResellerOnboarding["steps"]): number {
  const i = steps.findIndex((s) => !s.done);
  return i < 0 ? 0 : i;
}

/**
 * How a step enters (M1–M3): from the side it is walked toward, mirrored for a
 * right-to-left page; at `reduced` a fade only — no translate.
 */
export function setupSlide(level: MotionLevel, direction: 1 | -1, isRtl: boolean): { x?: number; opacity: number } {
  if (level === "reduced") return { opacity: 0 };
  return { x: direction * (isRtl ? -24 : 24), opacity: 0 };
}

/** How far a reseller's setup is, from the route — what the menu row draws (UX-2-e). */
export interface SetupProgress {
  done: number;
  total: number;
  complete: boolean;
  /** The gate: shut while no panel domain is proved. */
  onboarding: boolean;
}

export function setupProgress(v: ResellerOnboarding): SetupProgress {
  return { done: v.steps.filter((s) => s.done).length, total: v.steps.length, complete: v.complete, onboarding: v.onboarding };
}

/**
 * The gate lifted between two answers this view saw — never on the first
 * answer, so a reseller opened yesterday is not celebrated on every load (M5).
 */
export function gateOpened(before: SetupProgress | null, after: SetupProgress): boolean {
  return before !== null && before.onboarding && !after.onboarding;
}
