"use client";

import { Copy } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { WheelState, WheelVersion } from "@/lib/engagement-api";
import { formatMoney } from "../../../_lib/money";
import { formatDay } from "../../_lib/wheel";
import { PRIZE_TYPE_KEYS, WHEEL_SETTINGS_KEYS as K } from "../_lib/wheel-settings";
import { quietButton } from "./wheel-settings-ui";

/** Every version, newest first, each one's slots; any of them can start the next (F-707-f). */
export function WheelVersions({ state, onStartFrom }: { state: WheelState; onStartFrom: (v: WheelVersion) => void }) {
  const { lang, t } = useLocale();
  const cell = "px-3 py-2 text-start align-top";
  if (state.history.length === 0) return <p className="text-sm text-text-secondary">{t("common", K.none)}</p>;
  return (
    <div className="overflow-x-auto rounded-2xl border border-card-border bg-card-bg">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-[11px] text-text-secondary">
          <tr>
            <th className={cell}>{t("common", K.versions.version)}</th>
            <th className={cell}>{t("common", K.versions.from)}</th>
            <th className={cell}>{t("common", K.versions.cap)}</th>
            <th className={cell}>{t("common", K.versions.expected)}</th>
            <th className={cell}>{t("common", K.versions.prizes)}</th>
            <th className={cell}>{t("common", K.versions.state)}</th>
            <th className={cell} />
          </tr>
        </thead>
        <tbody>
          {state.history.map((v) => {
            const money = (a: string) => formatMoney(a, v.currencyCode, { lang, t });
            const tag = v.id === state.inForce?.id ? K.versions.inForce : v.id === state.next?.id ? K.versions.upcoming : null;
            return (
              <tr key={v.id} className="border-t border-card-border">
                <td className={`${cell} font-bold text-text-primary`}>
                  {v.version}
                  {tag && <span className="ms-2 rounded-md bg-[var(--leaf-bg)] px-1.5 py-0.5 text-[10px] text-primary">{t("common", tag)}</span>}
                </td>
                <td className={cell}>{formatDay(v.effectiveFromDay, lang)}</td>
                <td className={cell}>{money(v.dailyBudgetCapAmount)}</td>
                <td className={cell}>{money(v.expectedCostPerSpin)}</td>
                <td className={`${cell} text-xs text-text-secondary`}>
                  {v.prizes.map((p) => (
                    <div key={p.id} dir="auto">
                      {p.position}. {p.label} · {t("common", PRIZE_TYPE_KEYS[p.prizeType])} · ×{p.weight}
                    </div>
                  ))}
                </td>
                <td className={cell}>{t("common", v.isActive ? K.versions.on : K.versions.off)}</td>
                <td className={cell}>
                  <button type="button" className={quietButton} onClick={() => onStartFrom(v)}>
                    <Copy size={12} aria-hidden />
                    {t("common", K.versions.copy)}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
