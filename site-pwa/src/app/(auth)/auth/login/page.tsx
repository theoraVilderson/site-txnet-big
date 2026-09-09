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

type LoginMethod = "username" | "phone";

/** 1 credentials · "link" connect the messenger · 2 code */
type Step = 1 | "link" | 2;

export default function LoginPage() {
  const { t, isRtl, lang } = useAuthUI();
  const router = useRouter();
  const firstPaint = useFirstPaint();

  const [loginMethod, setLoginMethod] = useState<LoginMethod>("username");
  const [step, setStep] = useState<Step>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const captcha = useCaptcha();
  const otpTimer = useOtpTimer();
  const channels = useOtpChannels();
  const botLink = useBotLink(() => {
    setStep(2);
    otpTimer.start(120);
  });

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");

  const isPhoneMethod = loginMethod === "phone";

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
        if (isPhoneMethod) {
          let result;
          try {
            result = await authApi.requestLoginOtp(phone, captcha.token, channels.selected);
          } finally {
            captcha.spend();
          }
          if (result.linkRequired) {
            // The bot sends the code once the user confirms the number there.
            botLink.start(result);
            setStep("link");
          } else {
            setStep(2);
            otpTimer.start(120);
          }
        } else {
          let result;
          try {
            result = await authApi.loginPassword(username, password, captcha.token);
          } finally {
            captcha.spend();
          }
          if ("requiresOtp" in result) { setLoginMethod("phone"); setStep(2); otpTimer.start(120); }
          else { setIsSuccess(true); router.replace(PANEL_HOME); }
        }
      } else if (step === 2) {
        await authApi.verifyLoginOtp(phone, otp);
        setIsSuccess(true);
        router.replace(PANEL_HOME);
      }
    } catch (error) {
      submitError.capture(error);
    } finally {
      setIsLoading(false);
    }
  };

  const title = t.loginTitle;
  const subtitle =
    step === 1
      ? t.welcomeSubtitle
      : step === "link"
        ? t.botLinkWaiting
        : `${t.codeSentTo} ${phone || t.yourNumber}`;

  const buttonText = isLoading
    ? t.processing
    : step === 1
      ? isPhoneMethod
        ? t.getVerifyCode
        : t.loginToDashboard
      : t.verifyAndLogin;

  const canSubmitStep1 = isPhoneMethod
    ? captcha.verified && phone.length > 0
    : captcha.verified && username.length > 0 && password.length > 0;

  if (isSuccess) {
    return <SuccessShell title={t.loginSuccess} subtitle={t.redirecting} />;
  }

  return (
    <AnimatePresence mode="wait">
      <AuthCardShell animationKey="login" title={title} subtitle={subtitle}>
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
                <div className="flex bg-tab-bg rounded-2xl p-1.5 mb-8 relative z-0 border border-card-border shadow-inner">
                  {(
                    [
                      { id: "username", label: t.usernameTab },
                      { id: "phone", label: t.phoneTab },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setLoginMethod(tab.id)}
                      className={`relative flex-1 py-2.5 text-sm font-bold transition-colors duration-300 ${
                        loginMethod === tab.id
                          ? "text-primary"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {loginMethod === tab.id && (
                        <motion.div
                          layoutId="active-login-tab"
                          className="absolute inset-0 bg-tab-active rounded-xl shadow-md border border-card-border"
                          initial={false}
                          transition={{
                            type: "spring",
                            stiffness: 500,
                            damping: 35,
                          }}
                        />
                      )}
                      <span className="relative z-10">{tab.label}</span>
                    </button>
                  ))}
                </div>

                <motion.div
                  layout
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="relative min-h-[150px]"
                >
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={loginMethod}
                      initial={{
                        opacity: 0,
                        y: 15,
                        filter: "blur(4px)",
                        scale: 0.98,
                      }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        filter: "blur(0px)",
                        scale: 1,
                      }}
                      exit={{
                        opacity: 0,
                        y: -15,
                        filter: "blur(4px)",
                        scale: 0.98,
                      }}
                      transition={{ duration: 0.3, ease: "easeInOut" }}
                    >
                      {isPhoneMethod ? (
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
                      ) : (
                        <div className="space-y-6">
                          <OrganicField
                            id="username"
                            label={t.username}
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            dir="ltr"
                            autoComplete="username"
                          />
                          <PasswordField
                            id="password"
                            label={t.password}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            showLabel={t.showPassword}
                            hideLabel={t.hidePassword}
                            autoComplete="current-password"
                          />
                        </div>
                      )}
                    </motion.div>
                  </AnimatePresence>
                </motion.div>

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

                {isPhoneMethod && channels.hasChoice && (
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

        {step === 1 && <AuthFooterLinks variant="login" />}
      </AuthCardShell>
    </AnimatePresence>
  );
}
