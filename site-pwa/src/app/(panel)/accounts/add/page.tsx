"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound, MessageSquare } from "lucide-react";
import { OTPInput } from "@auth/auth/_components/OTPInput";
import { PhoneField } from "@auth/auth/_components/PhoneField";
import { useOtpChannels } from "@auth/auth/_hooks/useOtpChannels";
import { useAutofill } from "@auth/auth/_hooks/useAutofill";
import { authApi, type BotLinkRequired } from "@/lib/auth-api";
import { CHANNEL_LABEL, PROOF_LABEL, type Proof } from "./labels";
import { useLocale } from "@/context/LocaleContext";
import { OTP_LENGTH } from "@/lib/otp";
import { PANEL_HOME } from "@/lib/routes";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { useApiErrorMessage } from "@/hooks/useApiError";

import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The `common` namespace as generated constants (F-083, C-06). */
const C = FrontendI18nKeys.common;

/**
 * Adding another account to the switch group (F-0205, rendered for F-0209).
 *
 * The two tabs are the two proofs the API accepts, and they are offered as a
 * choice rather than a fallback: the account being added is a real account
 * whose owner is sitting here, so either its own code or its own password
 * settles the question. What is never offered is a way to add an account by
 * naming it — the credential asked for on this screen is the reason a switch
 * afterwards asks for none.
 */
export default function AddAccountPage() {
  const { t, lang } = useLocale();
  const router = useRouter();
  const { reload } = usePanelSession();
  const channels = useOtpChannels();

  const [proof, setProof] = useState<Proof>("otp");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  // These two have placeholders rather than floating labels, so nothing here
  // moves — but Confirm is disabled off `identifier`/`password`, and a fill
  // React never hears about leaves it disabled under a filled-looking form.
  // The password tab also mounts them late, which is why the hook holds the ref.
  const { ref: identifierRef } = useAutofill(identifier);
  const { ref: passwordRef } = useAutofill(password);
  const [codeSent, setCodeSent] = useState(false);
  const [botLink, setBotLink] = useState<BotLinkRequired | null>(null);
  const [pending, setPending] = useState(false);
  const toMessage = useApiErrorMessage();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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

  const requestCode = () =>
    run(async () => {
      const result = await authApi.addAccountOtpRequest(
        phoneNumber,
        channels.selected,
      );
      // The messenger this account picked is not connected to it yet, so no
      // code was sent: the bot sends one itself after the user shares their
      // contact there (F-0203). Showing "code sent" here would be a lie.
      if ("linkRequired" in result && result.linkRequired) {
        setBotLink(result);
        return;
      }
      setCodeSent(true);
    });

  const pollBotLink = (linkToken: string) =>
    run(async () => {
      const status = await authApi.botLinkStatus(linkToken);
      if (status.otpSent) {
        setBotLink(null);
        setCodeSent(true);
        return;
      }
      setError(t("common", C.accounts.linkPending));
    });

  const finish = async () => {
    await reload();
    setDone(true);
  };

  const verifyCode = () =>
    run(async () => {
      await authApi.addAccountOtpVerify(phoneNumber, otpCode);
      await finish();
    });

  const submitPassword = () =>
    run(async () => {
      await authApi.addAccountPassword(identifier, password);
      await finish();
    });

  const field =
    "autofill-tamed w-full rounded-2xl border-[1.5px] border-card-border bg-bg-inner px-5 py-3 text-text-primary outline-none transition-colors focus:border-primary";
  const button =
    "w-full rounded-2xl bg-primary px-5 py-3 font-bold text-white shadow-lg shadow-primary-glow transition-opacity disabled:opacity-60";

  if (done) {
    return (
      <div className="mx-auto w-full max-w-[440px] px-6 py-10">
        <h1 className="mb-2 text-xl font-bold text-text-primary">
          {t("common", C.accounts.addedTitle)}
        </h1>
        <p className="mb-6 text-sm text-text-secondary">
          {t("common", C.accounts.addedBody)}
        </p>
        <button
          type="button"
          className={button}
          onClick={() => router.push(PANEL_HOME)}
        >
          {t("common", C.accounts.backToPanel)}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[440px] px-6 py-10">
      <h1 className="mb-1 text-xl font-bold text-text-primary">
        {t("common", C.accounts.addTitle)}
      </h1>
      <p className="mb-6 text-sm text-text-secondary">
        {t("common", C.accounts.addSubtitle)}
      </p>

      <div className="mb-6 flex gap-1 rounded-2xl border border-card-border bg-tab-bg p-1.5">
        {(["otp", "password"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setProof(option);
              setError(null);
            }}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition-colors ${
              proof === option
                ? "text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {option === "otp" ? (
              <MessageSquare size={16} />
            ) : (
              <KeyRound size={16} />
            )}
            {t("common", PROOF_LABEL[option])}
          </button>
        ))}
      </div>

      {proof === "otp" && (
        <div className="space-y-4">
          <PhoneField
            id="add-account-phone"
            label={t("common", C.accounts.phonePlaceholder)}
            value={phoneNumber}
            onChange={setPhoneNumber}
            lang={lang}
            countryLabel={t("common", C.accounts.country)}
            searchLabel={t("common", C.accounts.countrySearch)}
            noResultsLabel={t("common", C.accounts.countryNoResults)}
            disabled={codeSent || !!botLink}
          />

          {channels.hasChoice && !codeSent && !botLink && (
            <div className="flex gap-1 rounded-2xl border border-card-border bg-tab-bg p-1.5">
              {channels.channels.map(({ channel }) => (
                <button
                  key={channel}
                  type="button"
                  onClick={() => channels.select(channel)}
                  className={`flex-1 rounded-xl py-2 text-sm font-bold transition-colors ${
                    channels.selected === channel
                      ? "text-primary"
                      : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {t("common", CHANNEL_LABEL[channel])}
                </button>
              ))}
            </div>
          )}

          {botLink && (
            <div className="space-y-3 rounded-2xl border border-card-border bg-bg-inner p-4">
              <p className="text-sm text-text-secondary">
                {t("common", C.accounts.linkRequired)}
              </p>
              <a
                href={botLink.deepLink}
                target="_blank"
                rel="noreferrer"
                className="block text-center text-sm font-bold text-primary underline"
              >
                {t("common", C.accounts.openBot)}
              </a>
              <button
                type="button"
                className={button}
                disabled={pending}
                onClick={() => pollBotLink(botLink.linkToken)}
              >
                {t("common", C.accounts.linkDone)}
              </button>
            </div>
          )}

          {codeSent && (
            <div dir="ltr">
              <OTPInput
                length={OTP_LENGTH}
                value={otpCode}
                onChange={setOtpCode}
              />
            </div>
          )}

          {!botLink && (
            <button
              type="button"
              className={button}
              disabled={pending || (codeSent ? otpCode.length < OTP_LENGTH : !phoneNumber)}
              onClick={codeSent ? verifyCode : requestCode}
            >
              {codeSent
                ? t("common", C.accounts.confirm)
                : t("common", C.accounts.sendCode)}
            </button>
          )}
        </div>
      )}

      {proof === "password" && (
        <div className="space-y-4">
          <input
            ref={identifierRef}
            className={field}
            dir="ltr"
            placeholder={t("common", C.accounts.identifierPlaceholder)}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
          <input
            ref={passwordRef}
            className={field}
            dir="ltr"
            type="password"
            autoComplete="off"
            placeholder={t("common", C.accounts.passwordPlaceholder)}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className={button}
            disabled={pending || !identifier || !password}
            onClick={submitPassword}
          >
            {t("common", C.accounts.confirm)}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-4 text-sm font-medium text-error" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => router.push(PANEL_HOME)}
        className="mt-6 flex items-center gap-2 text-sm text-text-secondary transition-colors hover:text-primary"
      >
        <ArrowRight size={16} className="ltr:-scale-x-100" />
        {t("common", C.accounts.backToPanel)}
      </button>
    </div>
  );
}
