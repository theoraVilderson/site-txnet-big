"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { aiAdminApi, type AiActionType, type AiSettings, type AiTypeActivity } from "@/lib/ai-api";
import { HOLDOUT, K, THRESHOLD_RE, card } from "./ai-ui";
import { draftOf, patchOf, silencedTypes, type Draft } from "./ai-settings";
import { AiAdvancedSettings } from "./AiAdvancedSettings";
import { AiLevelPicker } from "./AiLevelPicker";
import { AiTypeList } from "./AiTypeList";
import { SaveBar, Toggle } from "../../_components/kit";

type Activity = { windowDays: number; types: AiTypeActivity[] };

/**
 * The AI settings any admin can set (F-038-j4): the switch with what it did
 * lately, how bold to be as three levels, each type explained with its own
 * activity, and the exact numbers folded under "advanced". Activity is
 * ai's record (F-038-j3); when it cannot be read, everything still saves and
 * nothing about activity is claimed.
 */
export function AiSettingsPanel({ onOpenOffers }: { onOpenOffers: () => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [saved, setSaved] = useState<AiSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    aiAdminApi
      .settings()
      .then(({ settings }) => {
        if (!alive) return;
        setSaved(settings);
        setDraft(draftOf(settings));
      })
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    aiAdminApi
      .settingsActivity()
      .then((a) => alive && setActivity(a))
      // Activity only explains the settings; without it they are still set.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!saved || !draft) return <p className="text-sm text-text-secondary">{error ?? t("common", K.loading)}</p>;

  const holdout = Number(draft.holdoutPercent);
  const valid = THRESHOLD_RE.test(draft.confidenceThreshold) && Number.isInteger(holdout) && holdout >= HOLDOUT.min && holdout <= HOLDOUT.max;
  const patch = patchOf(saved, draft);
  const edit = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const toggleType = (type: AiActionType, on: boolean) => {
    const disabled = new Set(draft.disabled);
    if (on) disabled.delete(type);
    else disabled.add(type);
    edit({ disabled });
  };
  const sent = activity?.types.reduce((n, a) => n + a.sent, 0) ?? null;

  const save = async () => {
    setError(null);
    try {
      const { settings } = await aiAdminApi.saveSettings(patch);
      setSaved(settings);
      setDraft(draftOf(settings));
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className={`${card} flex flex-col gap-3`}>
        {!saved.engineRuns && (
          <p role="status" className="rounded-2xl bg-error/10 p-3 text-xs font-medium text-error">
            {t("common", K.settings.notRunning)}
          </p>
        )}
        <Toggle checked={draft.engineEnabled} onChange={(engineEnabled) => edit({ engineEnabled })} label={t("common", K.settings.engine)} hint={t("common", K.settings.engineHint)} />
        {activity && sent !== null && (
          <p className="text-xs text-text-secondary">
            {sent > 0 ? t("common", K.settings.summarySent, { days: activity.windowDays, count: sent }) : t("common", K.settings.summaryNone, { days: activity.windowDays })}
          </p>
        )}
      </section>

      <section className={`${card} flex flex-col gap-5`}>
        <AiLevelPicker
          threshold={draft.confidenceThreshold}
          onChange={(confidenceThreshold) => edit({ confidenceThreshold })}
          silenced={activity && silencedTypes(saved.actionTypes, draft.disabled, activity.types, draft.confidenceThreshold)}
        />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-text-primary">{t("common", K.settings.types)}</h3>
          <p className="text-xs text-text-secondary">{t("common", K.settings.typesHint)}</p>
          <AiTypeList types={saved.actionTypes} disabled={draft.disabled} activity={activity} threshold={draft.confidenceThreshold} onToggle={toggleType} onOpenOffers={onOpenOffers} />
        </div>
        <AiAdvancedSettings
          threshold={draft.confidenceThreshold}
          holdoutPercent={draft.holdoutPercent}
          onThreshold={(confidenceThreshold) => edit({ confidenceThreshold })}
          onHoldout={(holdoutPercent) => edit({ holdoutPercent })}
        />
        {error && <p role="alert" className="text-xs font-medium text-error">{error}</p>}
      </section>

      <SaveBar dirty={Object.keys(patch).length > 0} disabled={!valid} onSave={save} onDiscard={() => setDraft(draftOf(saved))} />
    </div>
  );
}
