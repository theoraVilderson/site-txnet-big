"use client";

import { useCallback } from "react";
import type { OtpDeliveryHandles } from "@/lib/auth-api";
import { OTP_RESEND_SECONDS } from "@/lib/otp";

type Parts = {
  delivery: { start: (handles: OtpDeliveryHandles) => void };
  otpTimer: { start: (seconds: number) => void };
  submitError: { clear: () => void; capture: (e: unknown) => void };
};

/**
 * "Resend code" sends one (F-0201-f): the step's own send again, then the
 * delivery status and the timer start over. A refusal is shown and the timer
 * stays at zero, so the button is still offered.
 */
export function useResend({ delivery, otpTimer, submitError }: Parts) {
  return useCallback(
    async <R extends Partial<OtpDeliveryHandles> & { linkRequired?: unknown }>(send: () => Promise<R>) => {
      submitError.clear();
      try {
        const result = await send();
        if (!result.linkRequired && result.deliveryId) delivery.start(result as OtpDeliveryHandles);
        otpTimer.start(OTP_RESEND_SECONDS);
        return result;
      } catch (e) {
        submitError.capture(e);
        return null;
      }
    },
    [delivery, otpTimer, submitError],
  );
}
