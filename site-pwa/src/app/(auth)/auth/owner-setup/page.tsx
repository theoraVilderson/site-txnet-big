"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence } from "framer-motion";
import { OrganicField } from "@auth/auth/_components/OrganicField";
import { AuthPhoneField } from "@auth/auth/_components/AuthPhoneField";
import { NewPasswordFields, passwordsDiffer } from "@auth/auth/_components/NewPasswordFields";
import { OtpChannelPicker } from "@auth/auth/_components/OtpChannelPicker";
import { ProofStep } from "@auth/auth/_components/ProofStep";
import { StepSlide } from "@auth/auth/_components/StepSlide";
import { SubmitButton } from "@auth/auth/_components/SubmitButton";
import { AuthCardShell, SuccessShell } from "@auth/auth/_components/AuthCardShell";
import { AuthFooterLinks } from "@auth/auth/_components/AuthFooterLinks";
import { SubmitFormError } from "@auth/auth/_components/FormError";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import { useOtpTimer } from "@auth/auth/_hooks/useOtpTimer";
import { useFirstPaint } from "@auth/auth/_hooks/useFirstPaint";
import { useSubmitError } from "@auth/auth/_hooks/useSubmitError";
import { useOtpChannels } from "@auth/auth/_hooks/useOtpChannels";
import { useBotLink } from "@auth/auth/_hooks/useBotLink";
import { useOtpDelivery } from "@auth/auth/_hooks/useOtpDelivery";
import { useResend } from "@auth/auth/_hooks/useResend";
import { authApi, heldSetupToken, releaseSetupToken } from "@/lib/auth-api";
import { OTP_LENGTH } from "@/lib/otp";
import { PANEL_HOME } from "@/lib/routes";

/**
 * F-0102: a fresh install owner's first sign-in. The password step answered a
 * setup token and no session; here the owner chooses the username and password
 * they keep and proves a mobile number of their own, and only then is signed in.
 * No captcha: the token from a captcha-gated password step is the proof.
 */
export default function OwnerSetupPage() {
  const { t } = useAuthUI();
  const router = useRouter();
  const firstPaint = useFirstPaint();
  // Held in memory by the login page; a reload has none and starts again there.
  const setupToken = heldSetupToken();

  /** 1 details · "link" connect the messenger · 2 code */
  const [step, setStep] = useState<1 | "link" | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const otpTimer = useOtpTimer();
  const channels = useOtpChannels();
  const delivery = useOtpDelivery();
  const botLink = useBotLink((status) => {
    setStep(2);
    otpTimer.startFrom(status);
  });

  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");

  const canSendCode = username.length > 0 && phone.length > 0 && password.length >= 8 && !passwordsDiffer(password, confirmPassword);

  const submitError = useSubmitError();
  const resend = useResend({ delivery, otpTimer, submitError });

  const sendCode = async (token: string) => {
    const result = await authApi.sendOwnerSetupCode(token, phone, channels.selected);
    if (result.linkRequired) {
      // Over a messenger, the bot sends the code once the number is proved there.
      botLink.start(result);
      setStep("link");
      return;
    }
    delivery.start(result);
    setStep(2);
    otpTimer.startFrom(result);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupToken) return;
    submitError.clear();
    setIsLoading(true);
    try {
      if (step === 1) {
        await sendCode(setupToken);
      } else if (step === 2) {
        await authApi.completeOwnerSetup({ setupToken, username, newPassword: password, phoneNumber: phone, otpCode: otp });
        releaseSetupToken();
        setIsSuccess(true);
        router.replace(PANEL_HOME);
      }
    } catch (error) {
      submitError.capture(error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isSuccess) return <SuccessShell title={t.ownerSetupSuccess} subtitle={t.redirecting} />;

  if (!setupToken) {
    return (
      <AuthCardShell animationKey="owner-setup-expired" title={t.ownerSetupTitle} subtitle={t.ownerSetupExpired}>
        <AuthFooterLinks variant="forgot-password" />
      </AuthCardShell>
    );
  }

  const subtitle = step === 1 ? t.ownerSetupSubtitle : step === "link" ? t.botLinkWaiting : `${t.codeSentTo} ${phone}`;
  const buttonText = isLoading ? t.processing : step === 1 ? t.ownerSetupAction : t.ownerSetupFinish;

  return (
    <AnimatePresence mode="wait">
      <AuthCardShell animationKey="owner-setup" title={t.ownerSetupTitle} subtitle={subtitle}>
        <form onSubmit={handleSubmit} noValidate>
          <SubmitFormError error={submitError.error} />
          <AnimatePresence mode="wait">
            {step === 1 ? (
              <StepSlide key="details" still={firstPaint}>
                <div className="space-y-6">
                  <OrganicField id="username" label={t.username} value={username} onChange={(e) => setUsername(e.target.value)} dir="ltr" autoComplete="username" />
                  <AuthPhoneField id="phone" value={phone} onChange={setPhone} />
                  <NewPasswordFields password={password} confirmation={confirmPassword} onPassword={setPassword} onConfirmation={setConfirmPassword} />
                </div>
                {channels.hasChoice && (
                  <div className="mt-6">
                    <OtpChannelPicker channels={channels.channels} selected={channels.selected} onSelect={channels.select} />
                  </div>
                )}
              </StepSlide>
            ) : (
              <ProofStep
                key={step}
                linking={step === "link"}
                botLink={botLink}
                code={otp}
                onCode={setOtp}
                timer={otpTimer}
                delivery={delivery}
                onResend={() => void resend(() => authApi.sendOwnerSetupCode(setupToken, phone, channels.selected))}
                onBack={() => setStep(1)}
              />
            )}
          </AnimatePresence>

          {step !== "link" && (
            <SubmitButton isLoading={isLoading} disabled={step === 1 ? !canSendCode : otp.length < OTP_LENGTH}>
              {buttonText}
            </SubmitButton>
          )}
        </form>
      </AuthCardShell>
    </AnimatePresence>
  );
}
