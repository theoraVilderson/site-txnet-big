"use client";

import { useMemo, useState } from "react";
import { NatureCaptchaUI } from "@auth/auth/_components/NatureCaptchaUI";
import { useCaptcha } from "@auth/auth/_hooks/useCaptcha";
import { useOtpChannels } from "@auth/auth/_hooks/useOtpChannels";
import { OtpChannelChoice } from "@auth/auth/_components/OtpChannelPicker";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { authApi } from "@/lib/auth-api";
import type { SwitchAccount } from "@/lib/auth/account";
import { OTP_LENGTH } from "@/lib/otp";
import { Alert, Button, Dialog, Input } from "./kit";

const C = FrontendI18nKeys.common.accounts;

/**
 * The switch into a holder of `*` (ADR-0145): their own password, then a code
 * by the channel they pick (SA-1-f), then the panel as them. The one-click switch is refused
 * them; this keeps the browser's other accounts signed in.
 */
export function TwoFactorSwitchDialog({ member, onClose }: { member: SwitchAccount; onClose: () => void }) {
  const { t, isRtl } = useLocale();
  const toMessage = useApiErrorMessage();
  const captcha = useCaptcha();
  const channels = useOtpChannels();
  const [password, setPassword] = useState("");
  const [otpToken, setOtpToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // The bot's deep link, when the chosen messenger is not connected yet: the bot sends the code.
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captchaLabels = useMemo(
    () => ({
      captchaVerified: t("common", C.captcha.verified),
      captchaSwipe: t("common", C.captcha.swipe),
      captchaChecking: t("common", C.captcha.checking),
    }),
    [t],
  );
  const channelLabels = useMemo(
    () => ({
      title: t("common", C.twoFactor.channelLabel),
      sms: t("common", C.channel.sms),
      telegram: t("common", C.channel.telegram),
      bale: t("common", C.channel.bale),
    }),
    [t],
  );

  async function run(work: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      if (!captcha.token) return;
      try {
        const sent = await authApi.switchByPassword(member.userId, password, captcha.token, channels.selected);
        setDeepLink(sent.linkRequired ? sent.deepLink : null);
        setOtpToken(sent.otpToken);
      } finally {
        // Single-use on the server, refused or not (F-0201).
        captcha.spend();
      }
    });

  const confirm = () =>
    run(async () => {
      if (!otpToken) return;
      await authApi.switchByCode(otpToken, code);
      // A full navigation, as every switch (F-0209): nothing of the account left behind survives.
      window.location.assign("/");
    });

  // "Send again or another way": back to the password, a fresh slide and the picker.
  const startOver = () => {
    setOtpToken(null);
    setCode("");
    setDeepLink(null);
  };

  const codeStep = otpToken !== null;
  return (
    <Dialog
      open
      onClose={() => !pending && onClose()}
      title={t("common", C.twoFactor.title, { name: member.fullName })}
      description={t("common", C.twoFactor.body)}
      footer={
        codeStep ? (
          <Button variant="primary" loading={pending} disabled={code.length !== OTP_LENGTH} onClick={() => void confirm()}>
            {t("common", C.confirm)}
          </Button>
        ) : (
          <Button variant="primary" loading={pending} disabled={!password || !captcha.verified} onClick={() => void sendCode()}>
            {t("common", C.sendCode)}
          </Button>
        )
      }
    >
      <div className="space-y-3">
        {error !== null && <Alert tone="error">{error}</Alert>}
        {codeStep ? (
          <>
            {deepLink ? (
              <p className="text-sm text-text-secondary">
                {t("common", C.twoFactor.linkBody)}{" "}
                <a href={deepLink} target="_blank" rel="noreferrer" className="font-bold text-primary underline">
                  {t("common", C.twoFactor.openBot)}
                </a>
              </p>
            ) : (
              <p className="text-sm text-text-secondary">{t("common", C.twoFactor.codeSent)}</p>
            )}
            <Input
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={OTP_LENGTH}
              placeholder={t("common", C.twoFactor.codePlaceholder)}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
            <Button variant="quiet" disabled={pending} onClick={startOver}>
              {t("common", C.twoFactor.sendAgain)}
            </Button>
          </>
        ) : (
          <>
            <Input
              type="password"
              autoComplete="current-password"
              placeholder={t("common", C.passwordPlaceholder)}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {channels.hasChoice && (
              <OtpChannelChoice channels={channels.channels} selected={channels.selected} onSelect={channels.select} labels={channelLabels} />
            )}
            <NatureCaptchaUI isVerified={captcha.verified} onVerify={captcha.complete} isRtl={isRtl} t={captchaLabels} />
          </>
        )}
      </div>
    </Dialog>
  );
}
