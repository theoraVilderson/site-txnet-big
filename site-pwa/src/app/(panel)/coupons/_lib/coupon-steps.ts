import type { CouponRejection } from "@/lib/billing-api";
import { emptyCouponForm, type CouponForm, type CouponFormErrors } from "./coupon-form";

/** The new-coupon wizard's steps, in order (UX-3-b); the edit sheet shows the same five as sections. */
export const COUPON_STEPS = ["basics", "limits", "schedule", "audience", "where", "review"] as const;
export type CouponStep = (typeof COUPON_STEPS)[number];
/** A step that holds fields — every one but the review. */
export type FieldStep = Exclude<CouponStep, "review">;

/** Which step asks for each field. Every `CouponForm` field is on exactly one (`coupon-wizard.test.tsx`). */
export const STEP_FIELDS: Record<FieldStep, readonly (keyof CouponForm)[]> = {
  basics: ["owner", "tenantId", "code", "label", "discountType", "discountValue", "grantVariantId", "maxDiscountCap", "isActive", "note"],
  limits: ["minPurchaseAmount", "maxPurchaseAmount", "totalUsageLimit", "perUserUsageLimit", "periodUsageLimit", "periodDays"],
  schedule: ["validFrom", "expiresAt", "activeWeekdays", "activeHourFrom", "activeHourTo"],
  audience: ["visibility", "allowedUserIds", "firstPurchaseOnly", "newUserWithinDays"],
  where: ["allowedChannels", "gateways", "productIds", "variantIds"],
};

/** The steps that hold fields, in order — the edit sheet's sections and the review's. */
export const FIELD_STEPS = COUPON_STEPS.filter((s): s is FieldStep => s !== "review");

/**
 * The errors one step shows and stops Next on — `validateCouponForm`'s, cut to
 * that step's fields, so the rules stay in one place. The review shows all.
 */
export function stepErrors(step: CouponStep, errors: CouponFormErrors): CouponFormErrors {
  if (step === "review") return errors;
  return Object.fromEntries(STEP_FIELDS[step].filter((k) => errors[k]).map((k) => [k, errors[k]]));
}

/** The first step with an error, where a refused review sends the admin back to. */
export function firstStepWithError(errors: CouponFormErrors): FieldStep | null {
  return FIELD_STEPS.find((s) => Object.keys(stepErrors(s, errors)).length > 0) ?? null;
}

/** Billing's refusals that name a field, by the step that asks for it; the rest stay on the review. */
const REFUSAL_STEP: Partial<Record<CouponRejection, FieldStep>> = {
  tenant_not_found: "basics",
  code_taken: "basics",
  invalid_code: "basics",
  invalid_value: "basics",
  variant_not_found: "basics",
  invalid_limit: "limits",
  limits_not_for_gift_codes: "limits",
  targeted_needs_users: "audience",
  user_out_of_scope: "audience",
  platform_coupon_needs_platform_gateway: "where",
  gateway_not_found: "where",
  scope_not_found: "where",
};

/** The step a refusal belongs to — given billing's reason or the error carrying it. */
export function refusalStep(e: unknown): FieldStep | null {
  const reason = typeof e === "string" ? e : (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? (REFUSAL_STEP[reason as CouponRejection] ?? null) : null;
}

const EMPTY = emptyCouponForm();

/** A step's fields that differ from a new form — what the review lists, and nothing else. */
export function setFields(f: CouponForm, step: FieldStep): (keyof CouponForm)[] {
  return STEP_FIELDS[step].filter((k) => JSON.stringify(f[k]) !== JSON.stringify(EMPTY[k]));
}

const HOURS_PER_DAY = 24;
/** The hour a window opens: 00:00 … 23:00 (billing's `activeHourFrom` 0–23). */
export const HOURS_FROM: readonly number[] = Array.from({ length: HOURS_PER_DAY }, (_, h) => h);
/** The hour it closes: 01:00 … 24:00 (`activeHourTo` 1–24). */
export const HOURS_TO: readonly number[] = HOURS_FROM.map((h) => h + 1);
/** An hour as a clock reads it, `HH:00`. */
export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
