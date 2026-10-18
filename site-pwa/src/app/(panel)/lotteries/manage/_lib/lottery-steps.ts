import type { StepHolds } from "../../../_components/prizes/prize-steps";
import { emptyLotteryForm, instantToWallClock, type LotteryAdminRefusal, type LotteryForm } from "./lottery-admin";

/** The draft wizard's steps, in order (UX-3-d). */
export const LOTTERY_STEPS = ["basics", "schedule", "rules", "prizes", "review"] as const;
export type LotteryStep = (typeof LOTTERY_STEPS)[number];
export type LotteryFieldStep = Exclude<LotteryStep, "review">;

/** The fields `validateLotteryForm` judges one by one. */
type CheckedField = "userGroupId" | "title" | "description" | "closesAt" | "requiresMinAccountAgeHours" | "reservesCount";

/** What each step asks for; every checked field sits on exactly one (`lottery-wizard.test.tsx`). */
export const LOTTERY_STEP_HOLDS: Record<LotteryFieldStep, StepHolds<CheckedField>> = {
  basics: ["title", "userGroupId", "description"],
  schedule: ["closesAt"],
  rules: ["requiresMinAccountAgeHours", "reservesCount"],
  prizes: "prizes",
};

/** Billing's refusals that name a part of the form, by the step holding it; the rest stay on the review. */
export const LOTTERY_REFUSAL_STEP: Partial<Record<LotteryAdminRefusal, LotteryFieldStep>> = {
  group_not_found: "basics",
  audience_not_allowed: "basics",
  invalid_close_time: "schedule",
  invalid_prize: "prizes",
  coupon_template_not_found: "prizes",
  variant_not_found: "prizes",
};

/** The close-time shortcuts, in days: a day, a week, a month (UX-3-d). */
export const CLOSE_SHORTCUTS = { day: 1, week: 7, month: 30 } as const;
export type CloseShortcut = keyof typeof CLOSE_SHORTCUTS;
/** A new draft closes a week out unless the admin says otherwise. */
export const DEFAULT_CLOSE: CloseShortcut = "week";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * `days` from `now` as `zone`'s wall clock for the close field, rounded up to
 * the wall's next whole hour — on the wall, not in UTC, so Tehran's +03:30
 * reads 20:00 and not 19:30. Rounding up keeps "one day" at least a day.
 */
export function closeAfterDays(days: number, now: Date, zone: string | null): string {
  const wall = instantToWallClock(new Date(now.getTime() + days * DAY_MS).toISOString(), zone);
  // The wall read as if UTC is only arithmetic here: it is formatted straight back.
  const asUtc = Date.parse(`${wall}:00Z`);
  return new Date(Math.ceil(asUtc / HOUR_MS) * HOUR_MS).toISOString().slice(0, 16);
}

/** A new draft: billing's defaults, closing {@link DEFAULT_CLOSE} from now. */
export function newLotteryForm(now: Date, zone: string | null): LotteryForm {
  return { ...emptyLotteryForm(), closesAt: closeAfterDays(CLOSE_SHORTCUTS[DEFAULT_CLOSE], now, zone) };
}
