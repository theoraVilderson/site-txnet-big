"use client";

import { useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { aiAdminApi, type LayoutFamily, type LayoutSuggestion } from "@/lib/ai-api";
import { catalogApi } from "@/lib/catalog-api";
import { flattenTexts } from "../../catalog/_lib/catalog-form";
import { formatBytes } from "../../services/_lib/service-configs";
import { K, card } from "./ai-ui";

/**
 * The plan layout (F-1527, over ai's `GET /api/ai/admin/plan-layout`): per
 * family of plans a user can move between, how much each plan's users use in
 * a period, and what that suggests — a smaller or a bigger plan, by size only,
 * or a plan nobody holds. The price is the reseller's to set: none is shown.
 */
export function PlanLayoutView() {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [families, setFamilies] = useState<LayoutFamily[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    aiAdminApi
      .planLayout()
      .then((r) => alive && setFamilies(r.families))
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    catalogApi
      .texts(lang)
      .then(flattenTexts)
      .catch(() => ({}))
      .then((flat) => alive && setTexts(flat));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const bytes = (b: string) => formatBytes(b, lang) ?? b;

  const say = (f: LayoutFamily, s: LayoutSuggestion) => {
    const p = f.plans.find((x) => x.variantId === s.variantId);
    const plan = (p && texts[p.nameKey]) || p?.sku || s.variantId;
    if (s.code === "no_takers") return t("common", K.layout.noTakers, { plan });
    const key = s.code === "add_smaller" ? K.layout.addSmaller : K.layout.addBigger;
    return t("common", key, { users: s.users, measured: s.measured, plan, size: bytes(s.size) });
  };

  return (
    <section className="flex flex-col gap-4">
      <p className="text-xs text-text-secondary">{t("common", K.layout.intro)}</p>
      {error && <p role="alert" className="text-xs font-medium text-error">{error}</p>}
      {families === null ? (
        !error && <p className="text-sm text-text-secondary">{t("common", K.loading)}</p>
      ) : families.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.layout.empty)}</p>
      ) : (
        families.map((f) => (
          <article key={`${f.productId}-${f.durationDays}`} className={`${card} flex flex-col gap-3`}>
            {f.durationDays !== null && <p className="text-xs font-bold text-text-secondary">{t("common", K.layout.period, { days: f.durationDays })}</p>}
            <ul className="flex flex-col gap-2">
              {f.plans.map((p) => (
                <li key={p.variantId} data-variant={p.variantId} className="flex flex-col gap-1 border-b border-card-border pb-2 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold text-text-primary">{texts[p.nameKey] || p.sku}</span>
                    <span className="text-xs text-text-secondary">{t("common", K.layout.users, { active: p.active, measured: p.measured })}</span>
                  </div>
                  {p.usage ? (
                    <p className="text-xs text-text-secondary">{t("common", K.layout.usage, { median: bytes(p.usage.p50), p75: bytes(p.usage.p75), p90: bytes(p.usage.p90) })}</p>
                  ) : (
                    <p className="text-xs text-text-secondary">{t("common", K.layout.notMeasured)}</p>
                  )}
                </li>
              ))}
            </ul>
            {f.suggestions.length > 0 && (
              <ul className="flex flex-col gap-2">
                {f.suggestions.map((s) => (
                  <li key={`${s.code}-${s.variantId}`} className="flex items-start gap-2 rounded-2xl border border-primary px-3 py-2 text-sm text-text-primary">
                    <Lightbulb size={16} aria-hidden className="mt-0.5 shrink-0 text-primary" />
                    <div className="flex flex-col gap-1">
                      <span>{say(f, s)}</span>
                      {s.code === "add_bigger" && <span className="text-xs text-text-secondary">{t("common", K.layout.censored)}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))
      )}
    </section>
  );
}
