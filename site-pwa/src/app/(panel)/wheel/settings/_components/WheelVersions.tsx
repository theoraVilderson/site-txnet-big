"use client";

import { Copy } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { WheelState, WheelVersion } from "@/lib/engagement-api";
import { formatMoney } from "../../../_lib/money";
import { formatDay } from "../../_lib/wheel";
import { PRIZE_TYPE_KEYS, WHEEL_SETTINGS_KEYS as K } from "../_lib/wheel-settings";
import { DataTable } from "../../../_components/kit/DataTable";

/** Every version, newest first, each one's slots; any of them can start the next (F-707-f). */
export function WheelVersions({ state, onStartFrom }: { state: WheelState; onStartFrom: (v: WheelVersion) => void }) {
  const { lang, t } = useLocale();
  if (state.history.length === 0) return <p className="text-sm text-text-secondary">{t("common", K.none)}</p>;
  return (
    <DataTable
      label={t("common", K.versions.title)}
      rows={state.history}
      rowKey={(v) => v.id}
      minWidth="min-w-[720px]"
      rowClassName="align-top"
      columns={[
        {
          id: "version",
          header: t("common", K.versions.version),
          cell: (v) => {
            const tag = v.id === state.inForce?.id ? K.versions.inForce : v.id === state.next?.id ? K.versions.upcoming : null;
            return (
              <>
                {v.version}
                {tag && <span className="ms-2 rounded-md bg-[var(--leaf-bg)] px-1.5 py-0.5 text-[10px] text-primary">{t("common", tag)}</span>}
              </>
            );
          },
          className: "font-bold text-text-primary",
        },
        { id: "from", header: t("common", K.versions.from), cell: (v) => formatDay(v.effectiveFromDay, lang) },
        { id: "cap", header: t("common", K.versions.cap), cell: (v) => formatMoney(v.dailyBudgetCapAmount, v.currencyCode, { lang, t }) },
        { id: "expected", header: t("common", K.versions.expected), cell: (v) => formatMoney(v.expectedCostPerSpin, v.currencyCode, { lang, t }) },
        {
          id: "prizes",
          header: t("common", K.versions.prizes),
          cell: (v) =>
            v.prizes.map((p) => (
              <div key={p.id} dir="auto">
                {p.position}. {p.label} · {t("common", PRIZE_TYPE_KEYS[p.prizeType])} · ×{p.weight}
              </div>
            )),
          className: "text-xs text-text-secondary",
          hideOnCard: true,
        },
        { id: "state", header: t("common", K.versions.state), cell: (v) => t("common", v.isActive ? K.versions.on : K.versions.off) },
      ]}
      actions={(v) => [{ id: "copy", label: t("common", K.versions.copy), icon: <Copy size={14} aria-hidden />, onSelect: () => onStartFrom(v) }]}
    />
  );
}
