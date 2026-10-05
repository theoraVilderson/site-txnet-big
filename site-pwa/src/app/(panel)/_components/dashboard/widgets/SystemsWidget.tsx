"use client";

import { Server } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { billingApi, type PanelReviewState } from "@/lib/billing-api";
import { PANEL_SYSTEMS } from "@/lib/routes";
import { REVIEW_KEYS } from "../../../systems/_lib/systems";
import { EmptyState, StatusPill, type Tone } from "../../kit";
import { FooterLink } from "../parts";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;

const ORDER: readonly PanelReviewState[] = ["accepted", "accepted_low_trust", "pending", "refused"];
const TONE: Record<PanelReviewState, Tone> = { accepted: "success", accepted_low_trust: "warning", pending: "info", refused: "error" };

/** Systems (UX-1-r, D5; the platform's only): the panels in service, counted by verdict; a verdict none holds is left out. */
export default function SystemsWidget() {
  const { t } = useLocale();
  const source = useWidgetSource("systems", async () => {
    const counts = new Map<PanelReviewState, number>();
    for (const p of await billingApi.systemsPanels()) {
      if (p.retiredAt !== null) continue;
      counts.set(p.review.reviewState, (counts.get(p.review.reviewState) ?? 0) + 1);
    }
    return ORDER.filter((s) => counts.has(s)).map((s) => ({ state: s, count: counts.get(s)! }));
  });
  return (
    <WidgetBody source={source} isEmpty={(rows) => rows.length === 0} empty={<EmptyState icon={Server} title={t("common", D.systems.none)} className="py-4" />}>
      {(rows) => (
        <div className="flex h-full flex-col">
          <ul className="flex flex-wrap gap-2">
            {rows.map((r) => (
              <li key={r.state}>
                <StatusPill tone={TONE[r.state]}>
                  <span>{t("common", REVIEW_KEYS[r.state])}</span>
                  <span className="tabular-nums">{r.count}</span>
                </StatusPill>
              </li>
            ))}
          </ul>
          <FooterLink href={PANEL_SYSTEMS}>{t("common", D.systems.open)}</FooterLink>
        </div>
      )}
    </WidgetBody>
  );
}
