"use client";

import { useState } from "react";
import { AlertCircle, Check, Loader2, MailCheck } from "lucide-react";
import { OTPInput } from "@auth/auth/_components/OTPInput";
import { useOtpDelivery } from "@auth/auth/_hooks/useOtpDelivery";
import { authApi } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { OTP_LENGTH } from "@/lib/otp";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { usePanelSession } from "../../_context/PanelSessionContext";

const E = FrontendI18nKeys.common.settings.email;

/**
 * A user adds an email address and proves it (F-035-j, over `auth-api` v14).
 *
 * Two steps, and the address is fixed between them: `sentTo` is the address
 * the code was mailed to, and it — not the field — is what confirm sends. The
 * field is locked while a code is out; "use a different address" is the only
 * way back, and it drops the delivery being watched.
 *
 * The account's address is read from the session (`GET auth/me`) after a
 * reload, never from what was typed: only confirm writes `user.email`.
 */
export function EmailSection() {
  const { t } = useLocale();
  const { me, reload } = usePanelSession();
  const toMessage = useApiErrorMessage();
  const { delivery, start, reset } = useOtpDelivery();

  const [address, setAddress] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  const sendCode = (to: string) =>
    run(async () => {
      const result = await authApi.requestEmailCode(to);
      setSentTo(to);
      setOtpCode("");
      setSaved(false);
      start(result);
    });

  const confirm = (to: string) =>
    run(async () => {
      await authApi.confirmEmail(to, otpCode);
      reset();
      setSentTo(null);
      setAddress("");
      setOtpCode("");
      setSaved(true);
      await reload();
    });

  const changeAddress = () => {
    reset();
    setSentTo(null);
    setOtpCode("");
    setError(null);
  };

  const button =
    "w-full rounded-2xl bg-primary px-5 py-3 font-bold text-white shadow-lg shadow-primary-glow transition-opacity disabled:opacity-60";
  const link = "text-sm font-bold text-primary hover:underline disabled:opacity-60";

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-6">
      <h2 className="mb-1 text-lg font-bold text-text-primary">{t("common", E.title)}</h2>
      <p className="mb-5 text-sm text-text-secondary">{t("common", E.subtitle)}</p>

      <div className="mb-5 rounded-2xl border border-card-border bg-bg-inner px-4 py-3">
        {me?.email ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span dir="ltr" className="font-medium text-text-primary">
              {me.email}
            </span>
            <span className="flex items-center gap-1 text-sm text-primary">
              <MailCheck size={16} aria-hidden />
              {t("common", E.verified)}
            </span>
          </div>
        ) : (
          <span className="text-sm text-text-secondary">{t("common", E.none)}</span>
        )}
      </div>

      {saved && (
        <p className="mb-4 text-sm font-medium text-primary" role="status">
          {t("common", E.saved)}
        </p>
      )}

      {me?.email && !sentTo && (
        <p className="mb-3 text-sm text-text-secondary">{t("common", E.replace)}</p>
      )}

      <div className="space-y-4">
        <div>
          <label htmlFor="settings-email" className="mb-2 block text-sm text-text-secondary">
            {t("common", E.address)}
          </label>
          <input
            id="settings-email"
            type="email"
            dir="ltr"
            autoComplete="email"
            className="w-full rounded-2xl border-[1.5px] border-card-border bg-bg-inner px-5 py-3 text-text-primary outline-none transition-colors focus:border-primary disabled:opacity-60"
            value={sentTo ?? address}
            disabled={sentTo !== null}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>

        {sentTo === null ? (
          <button
            type="button"
            className={button}
            disabled={pending || !address.trim()}
            onClick={() => sendCode(address.trim())}
          >
            {t("common", E.sendCode)}
          </button>
        ) : (
          <>
            <p className="text-sm text-text-secondary">
              {t("common", E.codeHint).replace("{{email}}", sentTo)}
            </p>
            <div dir="ltr">
              <OTPInput length={OTP_LENGTH} value={otpCode} onChange={setOtpCode} />
            </div>

            {delivery && (
              <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 text-sm">
                {delivery.state === "failed" ? (
                  // Any failure key reads as one line: the address is the
                  // user's own, and "try again" is the only thing to do.
                  <span className="flex items-center gap-2 font-bold text-error">
                    <AlertCircle size={16} aria-hidden />
                    {t("common", E.failed)}
                  </span>
                ) : delivery.state === "sent" ? (
                  <span className="flex items-center gap-2 text-text-secondary">
                    <Check size={16} className="text-primary" aria-hidden />
                    {t("common", E.sent)}
                  </span>
                ) : (
                  <span className="flex items-center gap-2 text-text-secondary">
                    <Loader2 size={16} className="animate-spin text-primary" aria-hidden />
                    {t("common", E.sending)}
                  </span>
                )}
              </div>
            )}

            <button
              type="button"
              className={button}
              disabled={pending || otpCode.length < OTP_LENGTH}
              onClick={() => confirm(sentTo)}
            >
              {t("common", E.confirm)}
            </button>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className={link} disabled={pending} onClick={() => sendCode(sentTo)}>
                {t("common", E.resend)}
              </button>
              <button type="button" className={link} disabled={pending} onClick={changeAddress}>
                {t("common", E.changeAddress)}
              </button>
            </div>
          </>
        )}

        {error && (
          <p className="text-sm font-medium text-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
