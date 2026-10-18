"use client";

import { Gauge, Shield, Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { AiActionType } from "@/lib/ai-api";
import { K } from "./ai-ui";
import { LEVEL_ORDER, THRESHOLD_LEVELS, levelOf, type ThresholdLevel } from "./ai-settings";
import { RadioCards } from "../../_components/kit";

const ICON = { careful: Shield, balanced: Gauge, more: Sparkles } as const;

interface Props {
  threshold: string;
  onChange: (threshold: string) => void;
  /** Switched-on types this threshold silences entirely; null while the activity is unknown. */
  silenced: AiActionType[] | null;
}

/**
 * "How many suggestions" as three levels instead of a 0–1 number (F-038-j4).
 * The line under them names what the chosen level silences before it is saved;
 * a number no level names is said as custom, with no level shown chosen.
 */
export function AiLevelPicker({ threshold, onChange, silenced }: Props) {
  const { t } = useLocale();
  const level = levelOf(threshold);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-bold text-text-primary">{t("common", K.settings.levelTitle)}</h3>
        <p className="text-xs text-text-secondary">{t("common", K.settings.levelHint)}</p>
      </div>
      <RadioCards<ThresholdLevel | "custom">
        ariaLabel={t("common", K.settings.levelTitle)}
        columns={3}
        value={level ?? "custom"}
        onChange={(l) => l !== "custom" && onChange(THRESHOLD_LEVELS[l])}
        options={LEVEL_ORDER.map((l) => ({ value: l, icon: ICON[l], label: t("common", K.settings.levels[l]), description: t("common", K.settings.levelsHint[l]) }))}
      />
      {!level && <p className="text-xs font-medium text-text-secondary">{t("common", K.settings.levelCustom, { value: threshold })}</p>}
      {silenced && (
        <p role="status" className={`rounded-2xl p-3 text-xs font-medium ${silenced.length > 0 ? "bg-warning/10 text-warning" : "bg-leaf-bg text-text-secondary"}`}>
          {silenced.length > 0
            ? t("common", K.settings.silenced, { types: silenced.map((x) => t("common", K.types[x])).join(", ") })
            : t("common", K.settings.silencedNone)}
        </p>
      )}
    </section>
  );
}
