/**
 * Digits in a one-time code. The API validates exactly this length
 * (`auth.schema.ts`, `register.schema.ts`), so the input must not accept a
 * different one — a 5-box input against a 6-digit code makes every submission
 * fail validation before it is ever compared.
 */
export const OTP_LENGTH = 6;

/** Seconds before "Resend code" is offered again — the OTP service's cooldown is shorter, so a resend is never refused for it. */
export const OTP_RESEND_SECONDS = 120;
