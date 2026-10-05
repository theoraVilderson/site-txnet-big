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
import { Alert } from "../../_components/kit/Alert";
import { Button } from "../../_components/kit/Button";
import { Card, CardHeader } from "../../_components/kit/Card";
import { Field, Input } from "../../_components/kit/Field";
import { notify } from "../../_components/kit/notify";

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
 * "Saved" is a toast (UX-1-s, K10); a refusal stays inline.
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
      start(result);
    });

  const confirm = (to: string) =>
    run(async () => {
      await authApi.confirmEmail(to, otpCode);
      reset();
      setSentTo(null);
      setAddress("");
      setOtpCode("");
      notify.success(t("common", E.saved));
      await reload();
    });

  const changeAddress = () => {
    reset();
    setSentTo(null);
    setOtpCode("");
    setError(null);
  };

  return (
    <Card padding="lg">
      <CardHeader title={t("common", E.title)} subtitle={t("common", E.subtitle)} />

      <div className="mb-5 rounded-xl border border-card-border bg-bg-inner px-4 py-3">
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

      <div className="space-y-4">
        <Field
          id="settings-email"
          label={t("common", E.address)}
          hint={me?.email && !sentTo ? t("common", E.replace) : undefined}
          error={sentTo === null ? (error ?? undefined) : undefined}
        >
          <Input
            type="email"
            dir="ltr"
            autoComplete="email"
            value={sentTo ?? address}
            disabled={sentTo !== null}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>

        {sentTo === null ? (
          <Button variant="primary" fullWidth loading={pending} disabled={!address.trim()} onClick={() => sendCode(address.trim())}>
            {t("common", E.sendCode)}
          </Button>
        ) : (
          <>
            <p className="text-sm text-text-secondary">{t("common", E.codeHint).replace("{{email}}", sentTo)}</p>
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

            <Button variant="primary" fullWidth loading={pending} disabled={otpCode.length < OTP_LENGTH} onClick={() => confirm(sentTo)}>
              {t("common", E.confirm)}
            </Button>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="quiet" size="sm" disabled={pending} onClick={() => sendCode(sentTo)}>
                {t("common", E.resend)}
              </Button>
              <Button variant="quiet" size="sm" disabled={pending} onClick={changeAddress}>
                {t("common", E.changeAddress)}
              </Button>
            </div>
            {error && <Alert tone="error">{error}</Alert>}
          </>
        )}
      </div>
    </Card>
  );
}
