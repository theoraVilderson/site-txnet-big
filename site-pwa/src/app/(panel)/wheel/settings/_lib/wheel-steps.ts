import type { WheelPrizeType } from "@/lib/engagement-api";
import type { StepHolds } from "../../../_components/prizes/prize-steps";
import { emptyPrize, type PrizeForm, type WheelSettingsRefusal } from "./wheel-settings";

/** The new-version wizard's steps, in order (UX-3-c). */
export const WHEEL_STEPS = ["basics", "eligibility", "prizes", "review"] as const;
export type WheelStep = (typeof WHEEL_STEPS)[number];
export type WheelFieldStep = Exclude<WheelStep, "review">;

/** The fields `validateWheelForm` judges one by one. */
type CheckedField = "cap" | "cooldownHours" | "maxSpins" | "minAgeHours" | "minPaid" | "minOrders" | "userGroupId";

/** What each step asks for; every checked field sits on exactly one (`wheel-wizard.test.tsx`). */
export const WHEEL_STEP_HOLDS: Record<WheelFieldStep, StepHolds<CheckedField>> = {
  basics: ["cap"],
  eligibility: ["maxSpins", "cooldownHours", "minAgeHours", "minPaid", "minOrders", "userGroupId"],
  prizes: "prizes",
};

/** Billing's refusals that name a part of the form, by the step holding it; the rest stay on the review. */
export const WHEEL_REFUSAL_STEP: Partial<Record<WheelSettingsRefusal, WheelFieldStep>> = {
  invalid_prize: "prizes",
  expected_cost_over_cap: "prizes",
  prize_cost_over_cap: "prizes",
  coupon_template_not_found: "prizes",
  variant_not_found: "prizes",
  group_not_found: "eligibility",
  audience_not_allowed: "eligibility",
};

/** The starter's slot names, in the admin's language (C-19): the wizard passes `t` through. */
export interface StarterLabels {
  tryAgain: string;
  gb: (n: number) => string;
  days: (n: number) => string;
}

type StarterSlot = { prizeType: WheelPrizeType; value: number; weight: number };

/**
 * A first wheel's slots (UX-3-c): misses between small prizes, the rare one
 * last, so the disc alternates and the odds read as a real wheel's. Values
 * are GB or days; the weights out of 130 give a miss about 69%.
 */
const STARTER: readonly StarterSlot[] = [
  { prizeType: "empty", value: 0, weight: 30 },
  { prizeType: "bonus_traffic_gb", value: 1, weight: 20 },
  { prizeType: "empty", value: 0, weight: 30 },
  { prizeType: "extra_days", value: 1, weight: 15 },
  { prizeType: "empty", value: 0, weight: 30 },
  { prizeType: "bonus_traffic_gb", value: 5, weight: 5 },
];

/**
 * The starter set as form slots. A miss costs nothing; a prize's cost is left
 * blank, since what a GB or a day costs the tenant is theirs to say — Next on
 * the prizes step stops at each one until it is typed.
 */
export function starterPrizes(labels: StarterLabels): PrizeForm[] {
  return STARTER.map(({ prizeType, value, weight }) => ({
    ...emptyPrize(),
    prizeType,
    label: prizeType === "empty" ? labels.tryAgain : prizeType === "extra_days" ? labels.days(value) : labels.gb(value),
    prizeValue: String(value),
    weight: String(weight),
    costAmount: prizeType === "empty" ? "0" : "",
  }));
}

/** Nothing typed into any slot yet: the starter set may replace them without losing work. */
export const slotsUntouched = (prizes: readonly PrizeForm[]) => prizes.every((p) => JSON.stringify(p) === JSON.stringify(emptyPrize()));
