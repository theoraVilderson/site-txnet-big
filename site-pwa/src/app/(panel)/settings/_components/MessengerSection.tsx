"use client";

import { useEffect, useState } from "react";
import { authApi, NOTICE_MESSENGERS, type MeMessenger, type NoticeMessenger } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const M = FrontendI18nKeys.common.settings.messenger;

/** Each choice's words — exhaustive, so a messenger added to the list without them does not compile. */
const OPTION_TEXT: Record<NoticeMessenger, string> = {
  both: M.options.both,
  telegram: M.options.telegram,
  bale: M.options.bale,
};

/**
 * Which messenger the user's notices take (F-601-u, over identity's
 * `/auth/me/messenger`): Telegram, Bale or both. Unchosen reads as both,
 * the server's default, so the form opens on it. A platform with no verified
 * chat can still be picked, and says so: until it is linked, the notifier
 * tells the other one — the server's rule, stated here, not enforced here.
 */
export function MessengerSection() {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [state, setState] = useState<MeMessenger | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    authApi
      .messenger()
      .then((m) => live && setState(m))
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, []);

  if (loadFailed) {
    return (
      <section className="mt-6 rounded-3xl border border-card-border bg-card-bg p-6">
        <p className="text-sm font-medium text-error" role="alert">
          {t("common", M.loadFailed)}
        </p>
      </section>
    );
  }
  if (!state) return null;

  const pick = (messenger: NoticeMessenger) => {
    setState({ ...state, messenger });
    setSaved(false);
    setError(null);
  };

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      setState(await authApi.saveMessenger(state.messenger));
      setSaved(true);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="mt-6 rounded-3xl border border-card-border bg-card-bg p-6">
      <h2 className="mb-1 text-lg font-bold text-text-primary">{t("common", M.title)}</h2>
      <p className="mb-5 text-sm text-text-secondary">{t("common", M.subtitle)}</p>

      <div role="radiogroup" aria-label={t("common", M.title)} className="space-y-3">
        {NOTICE_MESSENGERS.map((option) => {
          const unlinked = option !== "both" && !state.linked.includes(option);
          return (
            <label
              key={option}
              className={`flex cursor-pointer items-start gap-3 rounded-2xl border-[1.5px] px-4 py-3 transition-colors ${
                state.messenger === option ? "border-primary bg-bg-inner" : "border-card-border"
              }`}
            >
              <input
                type="radio"
                name="notice-messenger"
                className="mt-1 accent-primary"
                checked={state.messenger === option}
                onChange={() => pick(option)}
              />
              <span>
                <span className="block font-medium text-text-primary">{t("common", OPTION_TEXT[option])}</span>
                {unlinked && <span className="block text-sm text-text-secondary">{t("common", M.notLinked)}</span>}
              </span>
            </label>
          );
        })}
      </div>

      {saved && (
        <p className="mt-4 text-sm font-medium text-primary" role="status">
          {t("common", M.saved)}
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm font-medium text-error" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="mt-5 w-full rounded-2xl bg-primary px-5 py-3 font-bold text-white shadow-lg shadow-primary-glow transition-opacity disabled:opacity-60"
        disabled={pending}
        onClick={save}
      >
        {t("common", M.save)}
      </button>
    </section>
  );
}
