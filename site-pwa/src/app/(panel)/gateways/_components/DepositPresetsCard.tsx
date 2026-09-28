"use client";

import { useState } from "react";
import { Check, Loader2, Zap } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useGatewayMessage, type GatewaySurface } from "../_lib/surface";
import { samePresets } from "../_lib/presets";
import { PresetsEditor } from "./PresetsEditor";

const P = FrontendI18nKeys.common.gateways.presets;

/**
 * The tenant's default quick amounts (F-093-k over F-092-v), beside the
 * gateways they apply to — the one place a manager already is when deciding
 * how people pay. A gateway's own list, set in its form, overrides this one.
 */
export function DepositPresetsCard({ surface, initial, currency }: { surface: GatewaySurface; initial: string[]; currency: string }) {
  const { t } = useLocale();
  const errorMessage = useGatewayMessage(surface);
  const [list, setList] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const dirty = !samePresets(list, saved);

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const { presets } = await surface.api.setPresets(list);
      setList(presets);
      setSaved(presets);
      setDone(true);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-leaf-bg text-primary">
          <Zap size={18} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-text-primary">{t("common", P.title)}</h2>
          <p className="text-xs leading-6 text-text-secondary">{t("common", P.subtitle)}</p>
        </div>
      </div>

      <p className="mb-1.5 text-xs font-bold text-text-primary">{t("common", P.defaultTitle)}</p>
      <p className="mb-3 text-[11px] leading-5 text-text-secondary">{t("common", P.defaultHint)}</p>
      <PresetsEditor
        id="default-presets"
        currency={currency}
        value={list}
        onChange={(next) => {
          setList(next);
          setDone(false);
        }}
        emptyText={t("common", P.empty)}
      />

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        {failure && (
          <p role="alert" className="me-auto text-xs font-bold text-error">
            {failure}
          </p>
        )}
        {done && !dirty && (
          <p role="status" className="me-auto inline-flex items-center gap-1 text-xs font-bold text-success">
            <Check size={14} aria-hidden />
            {t("common", P.saved)}
          </p>
        )}
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("common", saving ? P.saving : P.save)}
        </button>
      </div>
    </section>
  );
}
