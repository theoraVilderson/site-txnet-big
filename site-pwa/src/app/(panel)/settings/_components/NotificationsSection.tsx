"use client";

import { useEffect, useState } from "react";
import { notificationApi, NOTICE_KINDS, type NoticeKind, type NoticePreferences } from "@/lib/notification-api";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Card, CardHeader } from "../../_components/kit/Card";
import { Alert } from "../../_components/kit/Alert";
import { Field, Input } from "../../_components/kit/Field";
import { SaveBar } from "../../_components/kit/SaveBar";
import { Toggle } from "../../_components/kit/Toggle";
import { ZoneSelect } from "../../_components/ZoneSelect";

const N = FrontendI18nKeys.common.settings.notifications;

/** Each kind's words — exhaustive, so a kind added to the list without them does not compile. */
const KIND_TEXT: Record<NoticeKind, { label: string; hint: string }> = {
  usage: N.kinds.usage,
  ending: N.kinds.ending,
  connect: N.kinds.connect,
  reactivated: N.kinds.reactivated,
  suggestion: N.kinds.suggestion,
  lottery: N.kinds.lottery,
};

/** What a freshly switched-on window reads before the user moves it. */
const DEFAULT_QUIET = { start: "23:00", end: "08:00" };

/**
 * The user mutes kinds of retention notice and sets quiet hours (F-601-m,
 * over `notification`'s `/notifications/preferences`). A switch that is on
 * means "tell me"; the cutoff notices have no switch — they are always told,
 * which the subtitle says. In quiet hours a notice reaches the inbox only and
 * the bot tells it when they end — the server's rule, stated here, not
 * enforced here.
 *
 * Saved whole through the `SaveBar` (UX-1-s, K11): the answer, not the form,
 * is what is kept after, so a value the server normalised reads as stored, and
 * Discard goes back to it.
 */
export function NotificationsSection() {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [stored, setStored] = useState<NoticePreferences | null>(null);
  const [prefs, setPrefs] = useState<NoticePreferences | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    notificationApi
      .preferences()
      .then((p) => {
        if (!live) return;
        setStored(p);
        setPrefs(p);
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, []);

  if (loadFailed) {
    return (
      <Card padding="lg">
        <Alert tone="error">{t("common", N.loadFailed)}</Alert>
      </Card>
    );
  }
  if (!prefs || !stored) return null;

  const edit = (next: NoticePreferences) => {
    setPrefs(next);
    setError(null);
  };
  const toggleKind = (kind: NoticeKind, told: boolean) =>
    edit({ ...prefs, muted: told ? prefs.muted.filter((k) => k !== kind) : [...prefs.muted, kind] });
  const sameTimes = prefs.quietHours !== null && prefs.quietHours.start === prefs.quietHours.end;
  const dirty = JSON.stringify(prefs) !== JSON.stringify(stored);

  const save = async () => {
    setError(null);
    try {
      const answer = await notificationApi.savePreferences(prefs);
      setStored(answer);
      setPrefs(answer);
    } catch (e) {
      setError(toMessage(e));
      throw e;
    }
  };

  return (
    <Card padding="lg">
      <CardHeader title={t("common", N.title)} subtitle={t("common", N.subtitle)} />

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
              <Field
                key={end}
                id={`quiet-${end}`}
                label={t("common", end === "start" ? N.quiet.from : N.quiet.to)}
                error={sameTimes && end === "end" ? t("common", N.quiet.sameTimes) : undefined}
              >
                <Input
                  type="time"
                  dir="ltr"
                  required
                  value={prefs.quietHours![end]}
                  onChange={(e) => e.target.value && edit({ ...prefs, quietHours: { ...prefs.quietHours!, [end]: e.target.value } })}
                />
              </Field>
            ))}
            {/* TZ-1-f: null follows the user's own zone, whatever it becomes. */}
            <Field id="quiet-zone" label={t("common", N.quiet.timezone)} className="col-span-2">
              <ZoneSelect value={prefs.timezone} nullLabel={t("common", N.quiet.sameAsMine)} onChange={(timezone) => edit({ ...prefs, timezone })} />
            </Field>
          </div>
        )}
      </div>

      {error && (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      )}

      <SaveBar
        dirty={dirty}
        disabled={sameTimes}
        onSave={save}
        onDiscard={() => edit(stored)}
        savedMessage={t("common", N.saved)}
      />
    </Card>
  );
}
