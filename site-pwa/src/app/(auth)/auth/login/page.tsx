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

type LoginMethod = "username" | "phone";

export default function LoginPage() {
  const { t, isRtl } = useAuthUI();
  const router = useRouter();
  const firstPaint = useFirstPaint();

  const [loginMethod, setLoginMethod] = useState<LoginMethod>("username");
  const [step, setStep] = useState<1 | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const otpTimer = useOtpTimer();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");

  const isPhoneMethod = loginMethod === "phone";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      if (step === 1) {
        if (isPhoneMethod) {
          await authApi.requestLoginOtp(phone);
          setStep(2);
          otpTimer.start(120);
        } else {
          const result = await authApi.loginPassword(username, password);
          if ("requiresOtp" in result) { setLoginMethod("phone"); setStep(2); otpTimer.start(120); }
          else { setIsSuccess(true); router.push("/dashboard"); }
        }
      } else {
        await authApi.verifyLoginOtp(phone, otp);
        setIsSuccess(true);
        router.push("/dashboard");
      }
    } catch (error) {
      console.error(error);
    } finally { setIsLoading(false); }
  };

  const title = t.loginTitle;
  const subtitle =
    step === 1 ? t.welcomeSubtitle : `${t.codeSentTo} ${phone || t.yourNumber}`;

  const buttonText = isLoading
    ? t.processing
    : step === 1
      ? isPhoneMethod
        ? t.getVerifyCode
        : t.loginToDashboard
      : t.verifyAndLogin;

  const canSubmitStep1 = isPhoneMethod
    ? captchaVerified && phone.length > 0
    : captchaVerified && username.length > 0 && password.length > 0;

  if (isSuccess) {
    return <SuccessShell title={t.loginSuccess} subtitle={t.redirecting} />;
  }

  return (
    <AnimatePresence mode="wait">
      <AuthCardShell animationKey="login" title={title} subtitle={subtitle}>
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
                        <OrganicField
                          id="phone"
                          label={t.phone}
                          type="tel"
                          value={phone}
                          onChange={(e: any) => setPhone(e.target.value)}
                          dir="ltr"
                        />
                      ) : (
                        <div className="space-y-6">
                          <OrganicField
                            id="username"
                            label={t.username}
                            value={username}
                            onChange={(e: any) => setUsername(e.target.value)}
                            dir="ltr"
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

        {step === 1 && <AuthFooterLinks variant="login" />}
      </AuthCardShell>
    </AnimatePresence>
  );
}
