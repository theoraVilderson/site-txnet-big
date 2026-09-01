"use client";

import { useMemo, useState } from "react";
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

export default function SignupPage() {
  const { t, isRtl } = useAuthUI();
  const router = useRouter();
  const firstPaint = useFirstPaint();

  const [step, setStep] = useState<1 | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const otpTimer = useOtpTimer();

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [userId, setUserId] = useState("");

  // Original page never asked for a password at signup at all - fixed here.
  const passwordsMismatch =
    confirmPassword.length > 0 && password !== confirmPassword;

  const canSubmitStep1 =
    captchaVerified &&
    fullName.length > 0 &&
    username.length > 0 &&
    phone.length > 0 &&
    password.length >= 8 &&
    !passwordsMismatch;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      if (step === 1) {
        const result = await authApi.register({ fullName, username, phoneNumber: phone, password });
        setUserId(result.userId); setStep(2); otpTimer.start(120);
      } else {
        await authApi.verifyPhone(userId, otp);
        setIsSuccess(true); router.push("/dashboard");
      }
    } catch (error) { console.error(error); }
    finally { setIsLoading(false); }
  };

  const subtitle = useMemo(
    () =>
      step === 1
        ? t.welcomeSubtitle
        : `${t.codeSentTo} ${phone || t.yourNumber}`,
    [step, phone, t],
  );

  const buttonText = isLoading
    ? t.processing
    : step === 1
      ? t.getVerifyCode
      : t.verifyAndLogin;

  if (isSuccess) {
    return <SuccessShell title={t.signupSuccess} subtitle={t.redirecting} />;
  }

  return (
    <AnimatePresence mode="wait">
      <AuthCardShell
        animationKey="signup"
        title={t.signupTitle}
        subtitle={subtitle}
      >
        <form onSubmit={handleSubmit} noValidate>
          <AnimatePresence mode="wait">
            {step === 1 ? (
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
                <div className="space-y-6">
                  <OrganicField
                    id="fullName"
                    label={t.fullName}
                    value={fullName}
                    onChange={(e: any) => setFullName(e.target.value)}
                  />
                  <OrganicField
                    id="username"
                    label={t.username}
                    value={username}
                    onChange={(e: any) => setUsername(e.target.value)}
                    dir="ltr"
                  />
                  <OrganicField
                    id="phone"
                    label={t.phone}
                    type="tel"
                    value={phone}
                    onChange={(e: any) => setPhone(e.target.value)}
                    dir="ltr"
                  />
                  <PasswordField
                    id="password"
                    label={t.password}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
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
                </div>

                <motion.div
                  layout
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="mb-4 mt-6"
                >
                  <NatureCaptchaUI
                    isVerified={captchaVerified}
                    onVerify={() => setCaptchaVerified(true)}
                    isRtl={isRtl}
                    t={t}
                  />
                </motion.div>
              </motion.div>
            ) : (
              <OtpStep
                value={otp}
                onChange={setOtp}
                timerSeconds={otpTimer.seconds}
                timerFormatted={otpTimer.formatted}
                onResend={() => otpTimer.start(120)}
                onEditPhone={() => setStep(1)}
              />
            )}
          </AnimatePresence>

          <SubmitButton
            isLoading={isLoading}
            disabled={step === 1 ? !canSubmitStep1 : otp.length < 5}
          >
            {buttonText}
          </SubmitButton>
        </form>

        {step === 1 && <AuthFooterLinks variant="signup" />}
      </AuthCardShell>
    </AnimatePresence>
  );
}
