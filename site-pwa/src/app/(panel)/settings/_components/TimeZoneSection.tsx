"use client";

import { useEffect, useState } from "react";
import { authApi, type MeTimeZone } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { browserZone } from "@/lib/time-zone";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { ZoneSelect } from "../../_components/ZoneSelect";

const Z = FrontendI18nKeys.common.timeZone;

/**
 * The user's own time zone (TZ-1-e, ADR-0108 point 7; auth-api
 * `contract.time-zone.md`). A pick is `source: user`. "Automatic" clears the
 * pick and lets this browser report again — two calls, because a browser
 * report is never stored over a pick. What reads as "now in use" is the
 * server's resolved answer, never inferred from the field, and the panel's
 * dates follow it at once (`zoneChanged`).
 */
export function TimeZoneSection() {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const { zoneChanged } = usePanelSession();
  const [stored, setStored] = useState<MeTimeZone | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [asked, setAsked] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const device = browserZone();

  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    authApi
      .timeZone()
      .then((z) => {
        if (!live) return;
        setStored(z);
        setPicked(z.source === "user" ? z.timezone : null);
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [asked]);

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      let answer = await authApi.saveTimeZone(picked, "user");
      if (picked === null && device) answer = await authApi.saveTimeZone(device, "browser");
      setStored(answer);
      setPicked(answer.source === "user" ? answer.timezone : null);
      zoneChanged(answer.resolved);
      setSaved(true);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setPending(false);
    }
  };

  const input =
    "w-full rounded-2xl border-[1.5px] border-card-border bg-bg-inner px-4 py-2.5 text-text-primary outline-none transition-colors focus:border-primary";
  const chosen = stored?.source === "user" ? stored.timezone : null;

  return (
    <section className="mt-6 rounded-3xl border border-card-border bg-card-bg p-6">
      <h2 className="mb-1 text-lg font-bold text-text-primary">{t("common", Z.title)}</h2>
      <p className="mb-5 text-sm text-text-secondary">{t("common", Z.hint)}</p>

      {loadFailed ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-error" role="alert">
            {t("common", Z.loadFailed)}
          </p>
          <button type="button" className="text-sm font-bold text-primary" onClick={() => setAsked((n) => n + 1)}>
            {t("common", Z.reload)}
          </button>
        </div>
      ) : stored === null ? null : (
        <div className="space-y-3">
          <label htmlFor="my-zone" className="mb-1 block text-sm text-text-secondary">
            {t("common", Z.label)}
          </label>
          <ZoneSelect
            id="my-zone"
            className={input}
            value={picked}
            disabled={pending}
            nullLabel={device ? t("common", Z.automatic, { zone: device }) : t("common", Z.automaticUnknown)}
            onChange={(zone) => {
              setPicked(zone);
              setSaved(false);
              setError(null);
            }}
          />
          <p className="text-sm text-text-secondary" dir="auto">
            {t("common", Z.inUse, { zone: stored.resolved.zone, from: t("common", Z.from[stored.resolved.from]) })}
          </p>
          {error && (
            <p className="text-sm font-medium text-error" role="alert">
              {error}
            </p>
          )}
          {saved && <p className="text-sm font-medium text-primary">{t("common", Z.saved)}</p>}
          <button
            type="button"
            className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
            disabled={pending || picked === chosen}
            onClick={save}
          >
            {t("common", Z.save)}
          </button>
        </div>
      )}
    </section>
  );
}
