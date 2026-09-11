import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { OtpChannel } from "@/lib/auth-api";

const C = FrontendI18nKeys.common;

/** How the incoming account proves itself. */
export type Proof = "otp" | "password";

/**
 * The label for each proof and each OTP channel (F-084, ADR-0036).
 *
 * These were built by concatenation — `` `accounts.proof.${option}` `` — which
 * generated constants cannot see: a renamed key is a compile error only where
 * the key is spelled out. An exhaustive `Record` over the union closes both
 * directions at once. A new proof or channel does not compile until it has a
 * row, and every row is a generated constant, so a renamed key does not
 * compile either. `labels.test.ts` then asserts every row has a sentence in
 * every shipped language, which is the one thing a type cannot say.
 */
export const PROOF_LABEL: Record<Proof, string> = {
  otp: C.accounts.proof.otp,
  password: C.accounts.proof.password,
};

export const CHANNEL_LABEL: Record<OtpChannel, string> = {
  sms: C.accounts.channel.sms,
  telegram: C.accounts.channel.telegram,
  bale: C.accounts.channel.bale,
};
