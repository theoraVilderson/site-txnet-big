"use client";

import { useCallback, useEffect, useState } from "react";
import { Dices, Plus, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { wheelAdminApi, type WheelState, type WheelVersion } from "@/lib/engagement-api";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatMoney } from "../../../_lib/money";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { formatDay } from "../../_lib/wheel";
import { WHEEL_SETTINGS_KEYS as K, canManageWheel } from "../_lib/wheel-settings";
import { Alert, primaryButton, quietButton, useMessage } from "./wheel-settings-ui";
import { WheelEditor } from "./WheelEditor";
import { WheelReport } from "./WheelReport";
import { WheelVersions } from "./WheelVersions";
import { PageHeader } from "../../../_components/kit/PageHeader";

type Tab = "settings" | "versions" | "report";

/**
 * A tenant admin's wheel (F-707-f), over billing's
 * `/api/billing/engagement/wheel` (F-707-c, F-707-e). What is in force today
 * and what tomorrow brings, a new version from any saved one, every version,
 * and the day report. No edit and no delete: a save is a new version from the
 * tenant's next day, so today's odds and cap never move under a user.
 *
 * The check here only spares a caller who typed the path a refused read.
 */
export function WheelSettingsView() {
  const { lang, t } = useLocale();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const message = useMessage();
  const allowed = canManageWheel(me);

  const [state, setState] = useState<WheelState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("settings");
  /** The version a new one starts from; `"blank"` for a first wheel. */
  const [editing, setEditing] = useState<WheelVersion | "blank" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    (async () => {
      try {
        const answer = await wheelAdminApi.state();
        if (!alive) return;
        setState(answer);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e);
      } finally {
        if (alive) setLoaded(asked);
      }
    })();
    return () => {
      alive = false;
    };
  }, [allowed, asked]);

  if (sessionLoading) return null;
  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 md:p-8">
        <Alert>{t("common", K.notAllowed)}</Alert>
      </div>
    );
  }

  const latest = state?.next ?? state?.inForce ?? state?.history[0] ?? null;
  const startFrom = (v: WheelVersion | null) => {
    setNotice(null);
    setTab("settings");
    setEditing(v ?? "blank");
  };
  const money = (amount: string, currency: string) => formatMoney(amount, currency, { lang, t });
  const tabButton = (id: Tab) =>
    `rounded-lg px-3 py-1.5 text-xs font-bold ${tab === id ? "bg-[var(--leaf-bg)] text-primary" : "text-text-secondary hover:text-text-primary"}`;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <PageHeader
        icon={Dices}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            {state && !editing && (
              <button type="button" className={primaryButton} onClick={() => startFrom(latest)}>
                <Plus size={14} aria-hidden />
                {t("common", K.newVersion)}
              </button>
            )}
          </>
        }
      />

      <nav className="flex gap-1" role="tablist">
        {(["settings", "versions", "report"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tabButton(id)} onClick={() => setTab(id)}>
            {t("common", K.tabs[id])}
          </button>
        ))}
      </nav>

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}

      {tab === "report" ? (
        <WheelReport today={state?.today ?? null} />
      ) : loaded !== asked ? (
        <TableSkeleton rows={4} columns={4} withPagination={false} />
      ) : error || !state ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : tab === "versions" ? (
        <WheelVersions state={state} onStartFrom={startFrom} />
      ) : (
        <div className="space-y-4">
          <section className="space-y-1 rounded-2xl border border-card-border bg-card-bg p-4 text-sm">
            {state.inForce ? (
              <p className="font-bold text-text-primary">
                {t("common", K.inForce, { version: state.inForce.version })}
                {!state.inForce.isActive && <span className="ms-2 text-xs text-text-secondary">({t("common", K.notActive)})</span>}
                <span className="ms-2 text-xs font-normal text-text-secondary">
                  {money(state.inForce.dailyBudgetCapAmount, state.inForce.currencyCode)} ·{" "}
                  {t("common", K.cost.expected, { amount: money(state.inForce.expectedCostPerSpin, state.inForce.currencyCode) })}
                </span>
              </p>
            ) : (
              <p className="text-text-secondary">{t("common", K.none)}</p>
            )}
            {state.next && <p className="text-xs text-text-secondary">{t("common", K.next, { version: state.next.version, day: formatDay(state.next.effectiveFromDay, lang) })}</p>}
          </section>

          {editing ? (
            <WheelEditor
              key={editing === "blank" ? "blank" : editing.id}
              from={editing === "blank" ? null : editing}
              today={state.today}
              currency={latest?.currencyCode ?? state.inForce?.currencyCode ?? null}
              onCancel={() => setEditing(null)}
              onSaved={(v) => {
                setEditing(null);
                setNotice(t("common", K.saved, { version: v.version, day: formatDay(v.effectiveFromDay, lang) }));
                reload();
              }}
            />
          ) : !latest ? (
            <button type="button" className={primaryButton} onClick={() => startFrom(null)}>
              <Plus size={14} aria-hidden />
              {t("common", K.newVersion)}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
