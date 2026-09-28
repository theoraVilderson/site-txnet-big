"use client";

import { useState } from "react";
import { AlertCircle, Bell, BellOff, Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { notificationApi, GRANT_NOTICE_LEVELS, type GrantNoticeLevel } from "@/lib/notification-api";

const N = FrontendI18nKeys.common.myServices.notices;

/** Each level's words and icon — exhaustive, so a level added to the list without them does not compile. */
const LEVEL_TEXT: Record<GrantNoticeLevel, { label: string; hint: string; icon: typeof Bell }> = {
  all: { label: N.all, hint: N.allHint, icon: Bell },
  essential: { label: N.essential, hint: N.essentialHint, icon: BellOff },
};

/**
 * How much the buyer is told about this one service (F-601-o, over
 * `notification`'s `/notifications/preferences/grants`): every notice, or
 * only when it stops or is about to be removed — for a service bought for a
 * friend. Beside the kinds muted on every service in `/settings`, never
 * instead of them.
 *
 * A tap saves at once, and the answer is what is shown after. `level` null is
 * a read that failed: one line and no choice, because a choice drawn as "all"
 * would be a guess shown as a fact.
 */
export function NoticeLevel({
  grantId,
  level,
  onSaved,
}: {
  grantId: string;
  level: GrantNoticeLevel | null;
  onSaved: (grantId: string, level: GrantNoticeLevel) => void;
}) {
  const { t } = useLocale();
  const [saving, setSaving] = useState<GrantNoticeLevel | null>(null);
  const [failed, setFailed] = useState(false);

  async function choose(next: GrantNoticeLevel) {
    if (next === level || saving !== null) return;
    setSaving(next);
    setFailed(false);
    try {
      const stored = await notificationApi.setGrantNoticeLevel(grantId, next);
      onSaved(grantId, stored.level);
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  }

  return (
    <section aria-label={t("common", N.title)} className="rounded-2xl border border-card-border p-3">
      <p className="text-sm font-bold text-text-primary">{t("common", N.title)}</p>
      <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", N.hint)}</p>

      {level === null ? (
        <p role="alert" className="mt-3 flex items-start gap-2 text-xs font-medium text-error">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
          {t("common", N.unavailable)}
        </p>
      ) : (
        <div role="radiogroup" aria-label={t("common", N.title)} className="mt-3 grid gap-2 sm:grid-cols-2">
          {GRANT_NOTICE_LEVELS.map((option) => {
            const text = LEVEL_TEXT[option];
            const checked = option === level;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={saving !== null}
                onClick={() => void choose(option)}
                className={`flex items-start gap-2.5 rounded-2xl border p-3 text-start transition-colors disabled:cursor-wait ${
                  checked ? "border-primary bg-leaf-bg" : "border-card-border bg-bg-inner hover:border-text-secondary"
                }`}
              >
                {saving === option ? (
                  <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-text-secondary" aria-hidden />
                ) : (
                  <text.icon size={16} className={`mt-0.5 shrink-0 ${checked ? "text-primary" : "text-text-secondary"}`} aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-text-primary">{t("common", text.label)}</span>
                  <span className="block text-xs leading-5 text-text-secondary">{t("common", text.hint)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {saving !== null && (
        <p role="status" className="mt-2 text-xs text-text-secondary">
          {t("common", N.saving)}
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-xs font-medium text-error">
          {t("common", N.failed)}
        </p>
      )}
    </section>
  );
}
