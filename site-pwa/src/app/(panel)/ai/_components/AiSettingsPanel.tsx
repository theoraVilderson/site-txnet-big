"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { aiAdminApi, type AiActionType, type AiSettings, type AiSettingsPatch } from "@/lib/ai-api";
import { HOLDOUT, K, THRESHOLD_RE, card, input, primaryButton } from "./ai-ui";

type Draft = { engineEnabled: boolean; confidenceThreshold: string; holdoutPercent: string; disabled: Set<AiActionType> };

const draftOf = (s: AiSettings): Draft => ({
  engineEnabled: s.engineEnabled,
  confidenceThreshold: s.confidenceThreshold,
  holdoutPercent: String(s.holdoutPercent),
  disabled: new Set(s.disabledActionTypes),
});

/**
 * Only what changed is sent: a save never writes back a value another admin
 * changed meanwhile. A threshold or holdout share the server would refuse
 * disables the save instead of reaching it (ai contract.admin.md rule 4).
 */
export function patchOf(saved: AiSettings, d: Draft): AiSettingsPatch {
  const patch: AiSettingsPatch = {};
  if (d.engineEnabled !== saved.engineEnabled) patch.engineEnabled = d.engineEnabled;
  if (Number(d.confidenceThreshold) !== Number(saved.confidenceThreshold)) patch.confidenceThreshold = d.confidenceThreshold;
  if (Number(d.holdoutPercent) !== saved.holdoutPercent) patch.holdoutPercent = Number(d.holdoutPercent);
  const before = new Set(saved.disabledActionTypes);
  if (d.disabled.size !== before.size || [...d.disabled].some((x) => !before.has(x))) {
    patch.disabledActionTypes = saved.actionTypes.filter((x) => d.disabled.has(x));
  }
  return patch;
}

export function AiSettingsPanel() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [saved, setSaved] = useState<AiSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);

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
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!saved || !draft) return <p className="text-sm text-text-secondary">{error ?? t("common", K.loading)}</p>;

  const holdout = Number(draft.holdoutPercent);
  const valid = THRESHOLD_RE.test(draft.confidenceThreshold) && Number.isInteger(holdout) && holdout >= HOLDOUT.min && holdout <= HOLDOUT.max;
  const patch = patchOf(saved, draft);
  const edit = (p: Partial<Draft>) => {
    setNotice(false);
    setDraft({ ...draft, ...p });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { settings } = await aiAdminApi.saveSettings(patch);
      setSaved(settings);
      setDraft(draftOf(settings));
      setNotice(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${card} flex flex-col gap-5`}>
      {!saved.engineRuns && (
        <p role="status" className="rounded-2xl bg-error/10 p-3 text-xs font-medium text-error">
          {t("common", K.settings.notRunning)}
        </p>
      )}
      <label className="flex items-start gap-3">
        <input type="checkbox" checked={draft.engineEnabled} onChange={(e) => edit({ engineEnabled: e.target.checked })} className="mt-1 size-4 accent-[var(--accent-primary)]" />
        <span>
          <span className="block text-sm font-bold text-text-primary">{t("common", K.settings.engine)}</span>
          <span className="block text-xs text-text-secondary">{t("common", K.settings.engineHint)}</span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ai-threshold" className="text-sm font-bold text-text-primary">{t("common", K.settings.threshold)}</label>
          <input id="ai-threshold" inputMode="decimal" dir="ltr" className={`${input} mt-1`} value={draft.confidenceThreshold} onChange={(e) => edit({ confidenceThreshold: e.target.value.trim() })} />
          <p className="mt-1 text-xs text-text-secondary">{t("common", K.settings.thresholdHint)}</p>
        </div>
        <div>
          <label htmlFor="ai-holdout" className="text-sm font-bold text-text-primary">{t("common", K.settings.holdout)}</label>
          <input id="ai-holdout" inputMode="numeric" dir="ltr" className={`${input} mt-1`} value={draft.holdoutPercent} onChange={(e) => edit({ holdoutPercent: e.target.value.trim() })} />
          <p className="mt-1 text-xs text-text-secondary">{t("common", K.settings.holdoutHint)}</p>
        </div>
      </div>

      <fieldset>
        <legend className="text-sm font-bold text-text-primary">{t("common", K.settings.types)}</legend>
        <p className="text-xs text-text-secondary">{t("common", K.settings.typesHint)}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {saved.actionTypes.map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={!draft.disabled.has(type)}
                onChange={(e) => {
                  const disabled = new Set(draft.disabled);
                  if (e.target.checked) disabled.delete(type);
                  else disabled.add(type);
                  edit({ disabled });
                }}
                className="size-4 accent-[var(--accent-primary)]"
              />
              {t("common", K.types[type])}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={primaryButton} disabled={busy || !valid || Object.keys(patch).length === 0} onClick={() => void save()}>
          {t("common", K.settings.save)}
        </button>
        {notice && <span role="status" className="text-xs font-bold text-primary">{t("common", K.saved)}</span>}
        {error && <span role="alert" className="text-xs font-medium text-error">{error}</span>}
      </div>
    </section>
  );
}
