"use client";

import { useEffect, useMemo, useState } from "react";
import { notificationApi, NOTICE_KINDS, type NoticeKind, type NoticePreferences } from "@/lib/notification-api";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Toggle } from "../../gateways/_components/gateway-fields";

const N = FrontendI18nKeys.common.settings.notifications;

/** Each kind's words — exhaustive, so a kind added to the list without them does not compile. */
const KIND_TEXT: Record<NoticeKind, { label: string; hint: string }> = {
  usage: N.kinds.usage,
  ending: N.kinds.ending,
  connect: N.kinds.connect,
  reactivated: N.kinds.reactivated,
};

/** What a freshly switched-on window reads before the user moves it. */
const DEFAULT_QUIET = { start: "23:00", end: "08:00" };

/** Every zone this browser knows, with the saved one kept even if it does not. */
function zones(saved: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(saved) ? all : [saved, ...all];
}

/**
 * The user mutes kinds of retention notice and sets quiet hours (F-601-m,
 * over `notification`'s `/notifications/preferences`). A switch that is on
 * means "tell me"; the cutoff notices have no switch — they are always told,
 * which the subtitle says. In quiet hours a notice reaches the inbox only and
 * the bot tells it when they end — the server's rule, stated here, not
 * enforced here.
 *
 * Saved whole with one button: the answer, not the form, is what is shown
 * after, so a value the server normalised reads as stored.
 */
export function NotificationsSection() {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [prefs, setPrefs] = useState<NoticePreferences | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    notificationApi
      .preferences()
      .then((p) => live && setPrefs(p))
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const zoneOptions = useMemo(() => (prefs ? zones(prefs.timezone) : []), [prefs]);

  if (loadFailed) {
    return (
      <section className="mt-6 rounded-3xl border border-card-border bg-card-bg p-6">
        <p className="text-sm font-medium text-error" role="alert">
          {t("common", N.loadFailed)}
        </p>
      </section>
    );
  }
  if (!prefs) return null;

  const edit = (next: NoticePreferences) => {
    setPrefs(next);
    setSaved(false);
    setError(null);
  };
  const toggleKind = (kind: NoticeKind, told: boolean) =>
    edit({ ...prefs, muted: told ? prefs.muted.filter((k) => k !== kind) : [...prefs.muted, kind] });
  const sameTimes = prefs.quietHours !== null && prefs.quietHours.start === prefs.quietHours.end;

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      setPrefs(await notificationApi.savePreferences(prefs));
      setSaved(true);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  const input =
    "w-full rounded-2xl border-[1.5px] border-card-border bg-bg-inner px-4 py-2.5 text-text-primary outline-none transition-colors focus:border-primary";

  return (
    <section className="mt-6 rounded-3xl border border-card-border bg-card-bg p-6">
      <h2 className="mb-1 text-lg font-bold text-text-primary">{t("common", N.title)}</h2>
      <p className="mb-5 text-sm text-text-secondary">{t("common", N.subtitle)}</p>

      <div className="space-y-3">
        {NOTICE_KINDS.map((kind) => (
          <Toggle
            key={kind}
            checked={!prefs.muted.includes(kind)}
            onChange={(told) => toggleKind(kind, told)}
            label={t("common", KIND_TEXT[kind].label)}
            hint={t("common", KIND_TEXT[kind].hint)}
          />
        ))}
      </div>

      <div className="mt-5 space-y-3">
        <Toggle
          checked={prefs.quietHours !== null}
          onChange={(on) => edit({ ...prefs, quietHours: on ? DEFAULT_QUIET : null })}
          label={t("common", N.quiet.label)}
          hint={t("common", N.quiet.hint)}
        />
        {prefs.quietHours && (
          <div className="grid grid-cols-2 gap-3">
            {(["start", "end"] as const).map((end) => (
              <div key={end}>
                <label htmlFor={`quiet-${end}`} className="mb-1 block text-sm text-text-secondary">
                  {t("common", end === "start" ? N.quiet.from : N.quiet.to)}
                </label>
                <input
                  id={`quiet-${end}`}
                  type="time"
                  dir="ltr"
                  required
                  className={input}
                  value={prefs.quietHours![end]}
                  onChange={(e) => e.target.value && edit({ ...prefs, quietHours: { ...prefs.quietHours!, [end]: e.target.value } })}
                />
              </div>
            ))}
            <div className="col-span-2">
              <label htmlFor="quiet-zone" className="mb-1 block text-sm text-text-secondary">
                {t("common", N.quiet.timezone)}
              </label>
              <select
                id="quiet-zone"
                dir="ltr"
                className={input}
                value={prefs.timezone}
                onChange={(e) => edit({ ...prefs, timezone: e.target.value })}
              >
                {zoneOptions.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>
            {sameTimes && (
              <p className="col-span-2 text-sm font-medium text-error" role="alert">
                {t("common", N.quiet.sameTimes)}
              </p>
            )}
          </div>
        )}
      </div>

      {saved && (
        <p className="mt-4 text-sm font-medium text-primary" role="status">
          {t("common", N.saved)}
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
        disabled={pending || sameTimes}
        onClick={save}
      >
        {t("common", N.save)}
      </button>
    </section>
  );
}
