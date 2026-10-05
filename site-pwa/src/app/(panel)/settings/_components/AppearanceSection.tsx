"use client";

import { Laptop, Moon, Sun, Waves, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useTheme } from "@/context/ThemeContext";
import { AVAILABLE_THEMES, type ThemeName } from "@/env";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { MotionPreference } from "@/lib/motion";
import { useUiPreferences } from "@/stores/ui-preferences-store";
import { Card, CardHeader } from "../../_components/kit/Card";
import { RadioCards, SegmentedControl } from "../../_components/kit/choice";

const A = FrontendI18nKeys.common.settings.appearance;

type ThemeChoice = ThemeName | "system";
const THEME_ICON: Record<ThemeChoice, LucideIcon> = { system: Laptop, light: Sun, dark: Moon, ocean: Waves };
const MOTION: readonly MotionPreference[] = ["system", "full", "reduced"];

/**
 * Theme, language and motion level (UX-1-s, `contract.ux.md` S1). Each is one
 * choice, applied the moment it is picked, so none needs a `SaveBar`: theme
 * and language are this device's (the providers keep them), the motion level
 * is the person's `ui.motion`, written by the preferences store (UX-1-l, P4).
 */
export function AppearanceSection() {
  const { t, lang, availableLocales, setLang } = useLocale();
  const { choice, setTheme } = useTheme();
  const motion = useUiPreferences((s) => s.prefs["ui.motion"]);

  return (
    <Card padding="lg">
      <CardHeader title={t("common", A.title)} subtitle={t("common", A.subtitle)} />
      <div className="space-y-6">
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-bold text-text-primary">{t("common", A.theme)}</legend>
          <RadioCards<ThemeChoice>
            ariaLabel={t("common", A.theme)}
            columns={2}
            value={choice}
            onChange={setTheme}
            options={(["system", ...AVAILABLE_THEMES] as ThemeChoice[]).map((v) => ({ value: v, label: t("common", A.themes[v]), icon: THEME_ICON[v] }))}
          />
        </fieldset>

        {availableLocales.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-bold text-text-primary">{t("common", A.language)}</legend>
            <SegmentedControl
              ariaLabel={t("common", A.language)}
              value={lang}
              onChange={(code) => void setLang(code)}
              options={availableLocales.map((l) => ({ value: l.code, label: l.name }))}
            />
          </fieldset>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-bold text-text-primary">{t("common", A.motion.label)}</legend>
          <SegmentedControl<MotionPreference>
            ariaLabel={t("common", A.motion.label)}
            value={motion}
            onChange={(v) => useUiPreferences.getState().update({ "ui.motion": v })}
            options={MOTION.map((v) => ({ value: v, label: t("common", A.motion[v]) }))}
          />
          <p className="text-xs text-text-secondary">{t("common", A.motion.hint)}</p>
        </fieldset>
      </div>
    </Card>
  );
}
