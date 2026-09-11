"use client";

import { motion } from "framer-motion";
import { AlertCircle, Check, ChevronRight, Loader2 } from "lucide-react";
import { OTPInput } from "@auth/auth/_components/OTPInput";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import { otpFailureString } from "@auth/auth/_lib/translations";
import type { OtpDelivery } from "@auth/auth/_hooks/useOtpDelivery";
import { OTP_LENGTH } from "@/lib/otp";

interface OtpStepProps {
  value: string;
  onChange: (val: string) => void;
  timerSeconds: number;
  timerFormatted: string;
  onResend: () => void;
  onEditPhone: () => void;
  /** What became of this code — `null` when nothing was queued (a bot link). */
  delivery: OtpDelivery | null;
}

export function OtpStep({
  value,
  onChange,
  timerSeconds,
  timerFormatted,
  onResend,
  onEditPhone,
  delivery,
}: OtpStepProps) {
  const { t, isRtl } = useAuthUI();

  return (
    <motion.div
      key="otp-step"
      initial={{ opacity: 0, x: isRtl ? 30 : -30, filter: "blur(5px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, x: isRtl ? -30 : 30, filter: "blur(5px)" }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="mb-5"
    >
      <OTPInput length={OTP_LENGTH} value={value} onChange={onChange} />

      {delivery && (
        <div
          role="status"
          aria-live="polite"
          className="mt-5 text-sm flex items-center justify-center gap-2 text-center"
        >
          {delivery.state === "failed" ? (
            <span className="text-error font-bold flex items-center gap-2">
              <AlertCircle size={16} aria-hidden />
              {t[otpFailureString(delivery.failureKey)]}
            </span>
          ) : delivery.state === "sent" ? (
            <span className="text-text-secondary flex items-center gap-2">
              <Check size={16} className="text-primary" aria-hidden />
              {t.otpDeliverySent}
            </span>
          ) : (
            /* Still queued: not yet, never "no such number" — the handles are
               minted before the route knows whether the account exists. */
            <span className="text-text-secondary flex items-center gap-2">
              <Loader2 size={16} className="animate-spin text-primary" aria-hidden />
              {t.otpDeliverySending}
            </span>
          )}
        </div>
      )}

      <div className="text-center mt-8">
        {timerSeconds > 0 ? (
          <div className="text-text-secondary text-sm flex items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin text-primary" />
            {t.resendCodeIn}{" "}
            <span className="font-mono font-bold text-text-primary dir-ltr inline-block min-w-[40px] text-center">
              {timerFormatted}
            </span>{" "}
            {t.seconds}
          </div>
        ) : (
          <button
            type="button"
            onClick={onResend}
            className="text-primary text-sm font-bold hover:underline transition-all"
          >
            {t.resendCode}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onEditPhone}
        className="mt-6 mx-auto flex items-center justify-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <ChevronRight size={16} className={isRtl ? "" : "rotate-180"} />
        {t.editPhone}
      </button>
    </motion.div>
  );
}
