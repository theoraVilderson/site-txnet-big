"use client";

import { useCallback } from "react";
import type { OtpDeliveryHandles } from "@/lib/auth-api";

type Parts = {
  delivery: { start: (handles: OtpDeliveryHandles) => void };
  otpTimer: { startFrom: (answer: { resendIn?: number }) => void; holdFor: (e: unknown) => boolean };
  submitError: { clear: () => void; capture: (e: unknown) => void };
};

/**
 * "Resend code" sends one (F-0201-f): the step's own send again, then the
 * delivery status and the timer start over, from the server's `resendIn`. A
 * refusal is shown; the timer counts only a cooldown's seconds left.
 */
export function useResend({ delivery, otpTimer, submitError }: Parts) {
  return useCallback(
    async <R extends Partial<OtpDeliveryHandles> & { linkRequired?: unknown; resendIn?: number }>(send: () => Promise<R>) => {
      submitError.clear();
      try {
        const result = await send();
        if (!result.linkRequired && result.deliveryId) delivery.start(result as OtpDeliveryHandles);
        otpTimer.startFrom(result);
        return result;
      } catch (e) {
        // A code sent to this number elsewhere: count the server's seconds.
        otpTimer.holdFor(e);
        submitError.capture(e);
        return null;
      }
    },
    [delivery, otpTimer, submitError],
  );
}
