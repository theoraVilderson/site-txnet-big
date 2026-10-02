"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { aiAdminApi, type AiMoney, type PlanMargin } from "@/lib/ai-api";
import { catalogApi } from "@/lib/catalog-api";
import { flattenTexts } from "../../catalog/_lib/catalog-form";
import { formatMoney } from "../../_lib/money";
import { K, card } from "./ai-ui";

type Why = keyof typeof K.margins.why;
const isWhy = (why: unknown): why is Why => typeof why === "string" && why in K.margins.why;

/**
 * Each plan's margin (F-1528, over ai's `GET /api/ai/admin/margins`): its
 * price against what the platform charges the tenant for it now, the losing
 * ones first and flagged. A cost ai does not know is said in words with its
 * reason, never shown as a number; a plan is named as the shop names it.
 */
export function MarginsList() {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [items, setItems] = useState<PlanMargin[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    aiAdminApi
      .margins()
      .then((r) => alive && setItems(r.items))
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

  const money = (m: AiMoney) => formatMoney(m.amount, m.currencyCode, { lang, t });
  const losing = items?.filter((p) => p.losingMoney).length ?? 0;

  return (
    <section className="flex flex-col gap-4">
      <p className="text-xs text-text-secondary">{t("common", K.margins.intro)}</p>
      {error && <p role="alert" className="text-xs font-medium text-error">{error}</p>}
      {losing > 0 && (
        <p role="status" className="flex items-center gap-2 rounded-2xl border border-error px-3 py-2 text-sm font-bold text-error">
          <AlertTriangle size={16} aria-hidden />
          {t("common", K.margins.losingCount, { count: losing })}
        </p>
      )}
      {items === null ? (
        !error && <p className="text-sm text-text-secondary">{t("common", K.loading)}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.margins.empty)}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((p) => {
            const why = p.reasons.find((r) => r.code === "cost_unknown")?.why;
            return (
              <li key={p.variantId} data-variant={p.variantId} className={`${card} flex flex-col gap-2 ${p.losingMoney ? "border-error" : ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-bold text-text-primary">{texts[p.nameKey] || p.sku}</span>
                  {p.losingMoney && <span className="rounded-full border border-error px-2 py-0.5 text-xs font-bold text-error">{t("common", K.margins.losing)}</span>}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-text-secondary">{t("common", K.margins.price)}</dt>
                    <dd className="font-bold text-text-primary">{money(p.price)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t("common", K.margins.cost)}</dt>
                    <dd className="font-bold text-text-primary">{p.cost ? money(p.cost) : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t("common", K.margins.margin)}</dt>
                    <dd className={`font-bold ${p.losingMoney ? "text-error" : "text-text-primary"}`}>{p.margin ? money(p.margin) : "—"}</dd>
                  </div>
                </dl>
                {!p.cost && (
                  <p className="text-xs text-text-secondary">
                    {t("common", K.margins.costUnknown)}
                    {isWhy(why) ? `: ${t("common", K.margins.why[why])}` : ""}
                  </p>
                )}
                {p.grants.active > 0 && (
                  <p className="text-xs text-text-secondary">
                    {t("common", K.margins.grants, { active: p.grants.active })}
                    {p.grants.losing > 0 && (
                      <>
                        {" · "}
                        <span className="font-bold text-error">{t("common", K.margins.grantsLosing, { losing: p.grants.losing })}</span>
                      </>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
