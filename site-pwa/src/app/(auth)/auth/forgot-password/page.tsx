"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { OrganicField } from "@auth/auth/_components/OrganicField";
import { PhoneField } from "@auth/auth/_components/PhoneField";
import { PasswordField } from "@auth/auth/_components/PasswordField";
import { NatureCaptchaUI } from "@auth/auth/_components/NatureCaptchaUI";
import { OtpStep } from "@auth/auth/_components/OtpStep";
import { OtpChannelPicker } from "@auth/auth/_components/OtpChannelPicker";
import { BotLinkStep } from "@auth/auth/_components/BotLinkStep";
import { SubmitButton } from "@auth/auth/_components/SubmitButton";
import {
  AuthCardShell,
  SuccessShell,
} from "@auth/auth/_components/AuthCardShell";
import { AuthFooterLinks } from "@auth/auth/_components/AuthFooterLinks";
import { FormError } from "@auth/auth/_components/FormError";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import { useOtpTimer } from "@auth/auth/_hooks/useOtpTimer";
import { useFirstPaint } from "@auth/auth/_hooks/useFirstPaint";
import { useSubmitError } from "@auth/auth/_hooks/useSubmitError";
import { useCaptcha } from "@auth/auth/_hooks/useCaptcha";
import { useOtpChannels } from "@auth/auth/_hooks/useOtpChannels";
import { useBotLink } from "@auth/auth/_hooks/useBotLink";
import { authApi } from "@/lib/auth-api";
import { PANEL_HOME } from "@/lib/routes";
import { OTP_LENGTH } from "@/lib/otp";

/** 1 phone + method · "link" connect the messenger · 2 code · 3 new password */
type Step = 1 | "link" | 2 | 3;

export default function ForgotPasswordPage() {
  const { t, isRtl, lang } = useAuthUI();
  const router = useRouter();
  const firstPaint = useFirstPaint();

  const [step, setStep] = useState<Step>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const captcha = useCaptcha();
  const otpTimer = useOtpTimer();
  const channels = useOtpChannels();
  // The bot delivers the code itself once the user confirms their number
  // there, so linking lands the flow straight on the code step.
  const botLink = useBotLink(() => {
    setStep(2);
    otpTimer.start(120);
  });

  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetToken, setResetToken] = useState("");

  const passwordsMismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;

  const submitError = useSubmitError();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    submitError.clear();
    setIsLoading(true);
    try {
      if (step === 1) {
        if (!captcha.token) return;
        // The pass is single-use on the server (F-0201): whatever happens
        // next, step 1 needs a fresh slide before it can be sent again.
        let result;
        try {
          result = await authApi.forgot(phone, captcha.token, channels.selected);
        } finally {
          captcha.spend();
        }
        if (result.linkRequired) {
          // Messenger not connected yet: no code was sent, and none will be
          // until the user proves the number is theirs in the bot.
          botLink.start(result);
          setStep("link");
        } else {
          setStep(2);
          otpTimer.start(120);
        }
      }
      else if (step === 2) { const result = await authApi.verifyForgot(phone, otp); setResetToken(result.resetToken); setStep(3); }
      else if (step === 3) {
        // The reset revoked every session this account had and issued a new
        // one for this device — so land in the panel, not back on the login
        // form.
        await authApi.reset(resetToken, newPassword);
        setIsSuccess(true);
        router.replace(PANEL_HOME);
      }
    } catch (error) {
      submitError.capture(error);
    } finally {
      setIsLoading(false);
    }
  };

  const title = step === 3 ? t.resetTitle : t.forgotTitle;
  const subtitle =
    step === 1
      ? t.forgotSubtitle
      : step === "link"
        ? t.botLinkWaiting
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

  const canSubmitStep1 = captcha.verified && phone.length > 0;
  const canSubmitStep3 =
    newPassword.length >= 8 && !passwordsMismatch && confirmPassword.length > 0;

  if (isSuccess) {
    return <SuccessShell title={t.resetSuccess} subtitle={t.redirecting} />;
  }

  return (
    <AnimatePresence mode="wait">
      <AuthCardShell animationKey="forgot" title={title} subtitle={subtitle}>
        <form onSubmit={handleSubmit} noValidate>
          <FormError
            message={submitError.error?.message ?? null}
            fieldErrors={submitError.error?.fieldErrors}
            reference={submitError.error?.ref}
          />
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
                <PhoneField
                  id="phone"
                  label={t.phone}
                  value={phone}
                  onChange={setPhone}
                  lang={lang}
                  countryLabel={t.country}
                  searchLabel={t.countrySearch}
                  noResultsLabel={t.countryNoResults}
                />

                <motion.div
                  layout
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="mb-4 mt-4"
                >
                  <NatureCaptchaUI
                    isVerified={captcha.verified}
                    onVerify={captcha.complete}
                    isRtl={isRtl}
                    t={t}
                  />
                </motion.div>

                {channels.hasChoice && (
                  <OtpChannelPicker
                    channels={channels.channels}
                    selected={channels.selected}
                    onSelect={channels.select}
                  />
                )}
              </motion.div>
            )}

            {step === "link" && botLink.link && (
              <BotLinkStep
                link={botLink.link}
                status={botLink.status}
                onBack={() => {
                  botLink.reset();
                  setStep(1);
                }}
              />
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

          {step !== "link" && (
            <SubmitButton
              isLoading={isLoading}
              disabled={
                step === 1
                  ? !canSubmitStep1
                  : step === 2
                    ? otp.length < OTP_LENGTH
                    : !canSubmitStep3
              }
            >
              {buttonText}
            </SubmitButton>
          )}
        </form>

        {step === 1 && <AuthFooterLinks variant="forgot-password" />}
      </AuthCardShell>
    </AnimatePresence>
  );
}
