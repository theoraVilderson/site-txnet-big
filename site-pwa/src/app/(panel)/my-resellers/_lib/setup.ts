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
