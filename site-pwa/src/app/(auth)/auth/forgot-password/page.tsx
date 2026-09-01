"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { OrganicField } from "@auth/auth/_components/OrganicField";
import { PasswordField } from "@auth/auth/_components/PasswordField";
import { NatureCaptchaUI } from "@auth/auth/_components/NatureCaptchaUI";
import { OtpStep } from "@auth/auth/_components/OtpStep";
import { SubmitButton } from "@auth/auth/_components/SubmitButton";
import {
  AuthCardShell,
  SuccessShell,
} from "@auth/auth/_components/AuthCardShell";
import { AuthFooterLinks } from "@auth/auth/_components/AuthFooterLinks";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import { useOtpTimer } from "@auth/auth/_hooks/useOtpTimer";
import { useFirstPaint } from "@auth/auth/_hooks/useFirstPaint";
import { authApi } from "@/lib/auth-api";

type Step = 1 | 2 | 3;

export default function ForgotPasswordPage() {
  const { t, isRtl } = useAuthUI();
  const router = useRouter();
  const firstPaint = useFirstPaint();

  const [step, setStep] = useState<Step>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const otpTimer = useOtpTimer();

  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetToken, setResetToken] = useState("");

  const passwordsMismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      if (step === 1) { await authApi.forgot(phone); setStep(2); otpTimer.start(120); }
      else if (step === 2) { const result = await authApi.verifyForgot(phone, otp); setResetToken(result.resetToken); setStep(3); }
      else { await authApi.reset(resetToken, newPassword); setIsSuccess(true); router.push("/auth/login"); }
    } catch (error) { console.error(error); }
    finally { setIsLoading(false); }
  };

  const title = step === 3 ? t.resetTitle : t.forgotTitle;
  const subtitle =
    step === 1
      ? t.forgotSubtitle
      : step === 2
        ? `${t.codeSentTo} ${phone || t.yourNumber}`
        : t.resetSubtitle;

  const buttonText = isLoading
    ? t.processing
    : step === 1
      ? t.sendRecoveryLink
      : step === 2
        ? t.verifyAndContinue
        : t.saveNewPassword;

  const canSubmitStep1 = captchaVerified && phone.length > 0;
  const canSubmitStep3 =
    newPassword.length >= 8 && !passwordsMismatch && confirmPassword.length > 0;

  if (isSuccess) {
    return <SuccessShell title={t.resetSuccess} subtitle={t.redirecting} />;
  }

  return (
    <AnimatePresence mode="wait">
      <AuthCardShell animationKey="forgot" title={title} subtitle={subtitle}>
        <form onSubmit={handleSubmit} noValidate>
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={
                  firstPaint
                    ? false
                    : { opacity: 0, x: isRtl ? -30 : 30, filter: "blur(5px)" }
                }
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: isRtl ? 30 : -30, filter: "blur(5px)" }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              >
                <OrganicField
                  id="phone"
                  label={t.phone}
                  type="tel"
                  value={phone}
                  onChange={(e: any) => setPhone(e.target.value)}
                  dir="ltr"
                />

                <motion.div
                  layout
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="mb-4 mt-4"
                >
                  <NatureCaptchaUI
                    isVerified={captchaVerified}
                    onVerify={() => setCaptchaVerified(true)}
                    isRtl={isRtl}
                    t={t}
                  />
                </motion.div>
              </motion.div>
            )}

            {step === 2 && (
              <OtpStep
                value={otp}
                onChange={setOtp}
                timerSeconds={otpTimer.seconds}
                timerFormatted={otpTimer.formatted}
                onResend={() => otpTimer.start(120)}
                onEditPhone={() => setStep(1)}
              />
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{
                  opacity: 0,
                  x: isRtl ? 30 : -30,
                  filter: "blur(5px)",
                }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: isRtl ? -30 : 30, filter: "blur(5px)" }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-6"
              >
                <PasswordField
                  id="newPassword"
                  label={t.newPassword}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  showLabel={t.showPassword}
                  hideLabel={t.hidePassword}
                />
                <PasswordField
                  id="confirmPassword"
                  label={t.confirmPassword}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  showLabel={t.showPassword}
                  hideLabel={t.hidePassword}
                  error={passwordsMismatch ? t.passwordMismatch : undefined}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <SubmitButton
            isLoading={isLoading}
            disabled={
              step === 1
                ? !canSubmitStep1
                : step === 2
                  ? otp.length < 5
                  : !canSubmitStep3
            }
          >
            {buttonText}
          </SubmitButton>
        </form>

        {step === 1 && <AuthFooterLinks variant="forgot-password" />}
      </AuthCardShell>
    </AnimatePresence>
  );
}
