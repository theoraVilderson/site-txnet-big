"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { AiOffers } from "./AiOffers";
import { AiSettingsPanel } from "./AiSettingsPanel";
import { AtRiskList } from "./AtRiskList";
import { K } from "./ai-ui";
import { MarginsList } from "./MarginsList";
import { UpliftReportView } from "./UpliftReportView";

const TABS = ["settings", "offers", "atRisk", "margins", "report"] as const;
type Tab = (typeof TABS)[number];

/**
 * The tenant's AI page (F-038-j2, ADR-0109 points 7, 13; ADR-0110) over ai's
 * `/api/ai/admin/*` (F-038-j1). Five tabs, each reading only when opened:
 * settings, the discount offers the engine may give, the customers at risk
 * with the engine's reasons, each plan's margin with the losing ones flagged
 * (F-1528), and the uplift report against the holdout.
 *
 * Nothing here decides scope: ai answers the gate's tenant, and no call names one.
 */
export function AiView() {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("settings");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
          <Sparkles size={18} className="text-primary" aria-hidden />
          {t("common", K.title)}
        </h1>
        <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
      </header>

      <div role="tablist" className="flex gap-2 overflow-x-auto rounded-2xl border border-card-border bg-card-bg p-1 shadow-sm">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-bold transition-colors ${tab === id ? "bg-primary text-white shadow-sm" : "text-text-secondary hover:text-text-primary"}`}
          >
            {t("common", K.tabs[id])}
          </button>
        ))}
      </div>

      {tab === "settings" ? <AiSettingsPanel /> : tab === "offers" ? <AiOffers /> : tab === "atRisk" ? <AtRiskList /> : tab === "margins" ? <MarginsList /> : <UpliftReportView />}
    </div>
  );
}
