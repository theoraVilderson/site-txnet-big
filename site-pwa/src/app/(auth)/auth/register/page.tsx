"use client";

import { useMemo, useState } from "react";
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
import { OTP_LENGTH } from "@/lib/otp";
import { PANEL_HOME } from "@/lib/routes";

export default function RegisterPage() {
  const { t, isRtl, lang } = useAuthUI();
  const router = useRouter();
  const firstPaint = useFirstPaint();

  /** 1 details · "link" connect the messenger · 2 code */
  const [step, setStep] = useState<1 | "link" | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const captcha = useCaptcha();
  const otpTimer = useOtpTimer();
  const channels = useOtpChannels();
  const botLink = useBotLink(() => {
    setStep(2);
    otpTimer.start(120);
  });

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");

  // Original page never asked for a password at registration at all - fixed here.
  const passwordsMismatch =
    confirmPassword.length > 0 && password !== confirmPassword;

  const canSubmitStep1 =
    captcha.verified &&
    fullName.length > 0 &&
    username.length > 0 &&
    phone.length > 0 &&
    password.length >= 8 &&
    !passwordsMismatch;

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
          result = await authApi.register({ fullName, username, phoneNumber: phone, password }, captcha.token, channels.selected);
        } finally {
          captcha.spend();
        }
        if (result.linkRequired) {
          // Registering over a messenger: the code is sent by the bot once
          // this person proves the number is theirs there.
          botLink.start(result);
          setStep("link");
        } else {
          setStep(2); otpTimer.start(120);
        }
      } else if (step === 2) {
        await authApi.verifyPhone(phone, otp);
        setIsSuccess(true); router.replace(PANEL_HOME);
      }
    } catch (error) {
      submitError.capture(error);
    } finally {
      setIsLoading(false);
    }
  };

  const subtitle = useMemo(
    () =>
      step === 1
        ? t.welcomeSubtitle
        : step === "link"
          ? t.botLinkWaiting
          : `${t.codeSentTo} ${phone || t.yourNumber}`,
    [step, phone, t],
  );

  const buttonText = isLoading
    ? t.processing
    : step === 1
      ? t.getVerifyCode
      : t.verifyAndLogin;

  if (isSuccess) {
    return <SuccessShell title={t.registerSuccess} subtitle={t.redirecting} />;
  }

  return (
    <AnimatePresence mode="wait">
      <AuthCardShell
        animationKey="register"
        title={t.registerTitle}
        subtitle={subtitle}
      >
        <form onSubmit={handleSubmit} noValidate>
          <FormError
            message={submitError.error?.message ?? null}
            fieldErrors={submitError.error?.fieldErrors}
            reference={submitError.error?.ref}
          />
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
                    onChange={(e) => setFullName(e.target.value)}
                    autoComplete="name"
                  />
                  <OrganicField
                    id="username"
                    label={t.username}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    dir="ltr"
                    autoComplete="username"
                  />
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
            ) : step === "link" && botLink.link ? (
              <BotLinkStep
                link={botLink.link}
                status={botLink.status}
                onBack={() => {
                  botLink.reset();
                  setStep(1);
                }}
              />
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

          {step !== "link" && (
            <SubmitButton
              isLoading={isLoading}
              disabled={step === 1 ? !canSubmitStep1 : otp.length < OTP_LENGTH}
            >
              {buttonText}
            </SubmitButton>
          )}
        </form>

        {step === 1 && <AuthFooterLinks variant="register" />}
      </AuthCardShell>
    </AnimatePresence>
  );
}
