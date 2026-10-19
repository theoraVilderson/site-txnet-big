import { ApiError } from "@/lib/api-error";

/**
 * Digits in a one-time code. The API validates exactly this length
 * (`auth.schema.ts`, `register.schema.ts`), so the input must not accept a
 * different one — a 5-box input against a 6-digit code makes every submission
 * fail validation before it is ever compared.
 */
export const OTP_LENGTH = 6;

/**
 * Seconds before "Resend code" is offered again: the `resendIn` the server put
 * on a code-sent answer — its own cooldown, never a figure of this client's
 * (2026-10-19: the auth pages counted 120s, add-account 60s). 0 when it said
 * nothing, so the button is offered and a refusal names the wait instead.
 */
export function resendInOf(answer: { resendIn?: number } | null | undefined): number {
  const seconds = answer?.resendIn;
  return typeof seconds === "number" && seconds > 0 ? seconds : 0;
}

/** The seconds left on an `otpCooldown` refusal (`facts.retryAfter`), or null when `e` is not one. */
export function otpCooldownOf(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.reason !== "otpCooldown") return null;
  const seconds = e.facts.retryAfter;
  return typeof seconds === "number" && seconds > 0 ? seconds : null;
}
