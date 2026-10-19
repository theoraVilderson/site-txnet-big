import { useEffect, useState } from "react";
import { otpCooldownOf, resendInOf } from "@/lib/otp";

export function useOtpTimer(initialSeconds = 0) {
  const [seconds, setSeconds] = useState(initialSeconds);

  useEffect(() => {
    if (seconds <= 0) return;
    const interval = setInterval(() => setSeconds((p) => p - 1), 1000);
    return () => clearInterval(interval);
  }, [seconds]);

  const start = (duration: number) => setSeconds(duration);
  /** Counts the wait a code-sent answer named (`resendIn`). */
  const startFrom = (answer: { resendIn?: number } | null | undefined) => setSeconds(resendInOf(answer));
  /** Counts the wait an `otpCooldown` refusal named; false when `e` is another refusal. */
  const holdFor = (e: unknown) => {
    const left = otpCooldownOf(e);
    if (left !== null) setSeconds(left);
    return left !== null;
  };

  const formatted = (() => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  })();

  return { seconds, start, startFrom, holdFor, formatted, isRunning: seconds > 0 };
}
