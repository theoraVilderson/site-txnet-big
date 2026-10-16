"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelCostHistory } from "@/lib/billing-api";
import { Button, Field, Input, notify } from "../../_components/kit";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { firstOpenDay, panelCostBodyOf } from "../_lib/panel-cost";
import { SYSTEMS_KEYS as K } from "../_lib/systems";
import { REFUSAL_KEYS } from "../_lib/systems-refusals";
import { useSystemsError } from "./parts";

/** Panels are bought in dollars (network `contract.panel-cost.md` rule 5). */
const PANEL_CURRENCY = "USD";

/** Today's UTC day: the months a price closes in are UTC months. */
const utcToday = () => new Date().toISOString().slice(0, 10);

/**
 * A panel's monthly cost (F-1002-c): the price in effect, a new one from a
 * day (today by default, never before this month), and every price before it.
 * A save adds a row; billing never edits one, so the history only grows.
 */
export function PanelCost({ panelId, today: given }: { panelId: string; today?: string }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const [today] = useState(() => given ?? utcToday());
  const [costs, setCosts] = useState<PanelCostHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ amount: "", from: today });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    billingApi.panelCost(panelId).then(
      (c) => live && setCosts(c),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [panelId]);

  const checked = panelCostBodyOf(form, today);
  const problem = "error" in checked && form.amount !== "" ? (checked.error === "closedMonth" ? REFUSAL_KEYS.cost_in_closed_month : K.cost.amountInvalid) : null;
  const usd = (amount: string) => formatMoney(amount, PANEL_CURRENCY, { lang, t });
  const day = (d: string) => formatInstant(`${d}T12:00:00Z`, lang, { withTime: false }) ?? d;

  const save = async () => {
    if (!("body" in checked)) return;
    setSaving(true);
    try {
      setCosts(await billingApi.setPanelCost(panelId, checked.body));
      setForm({ amount: "", from: today });
      notify.success(t("common", K.cost.saved));
    } catch (e) {
      notify.error(message(e));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p role="alert" className="text-xs font-bold text-error">{message(error)}</p>;
  if (!costs) {
    return (
      <p className="flex items-center gap-2 text-xs text-text-secondary">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        {t("common", K.loading)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-5 text-text-secondary">{t("common", K.cost.intro)}</p>
      <p className="rounded-xl bg-bg-inner px-3 py-2 text-sm text-text-primary">
        {costs.current ? t("common", K.cost.current, { amount: usd(costs.current.monthlyCostUsd), from: day(costs.current.effectiveFrom) }) : t("common", K.cost.none)}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("common", K.cost.amount)}>
          <Input dir="ltr" inputMode="decimal" className="w-32" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label={t("common", K.cost.from)}>
          <Input dir="ltr" type="date" min={firstOpenDay(today)} className="w-40" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </Field>
        <Button size="sm" onClick={save} disabled={!("body" in checked) || saving}>
          {t("common", K.cost.save)}
        </Button>
      </div>
      {problem && <p className="text-xs text-error">{t("common", problem)}</p>}

      {costs.history.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-bold text-text-primary">{t("common", K.cost.history)}</p>
          <ul className="divide-y divide-card-border rounded-xl bg-bg-inner px-3 text-xs">
            {costs.history.map((c) => (
              <li key={`${c.effectiveFrom}-${c.createdAt}`} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-text-secondary">{t("common", K.cost.fromDay, { from: day(c.effectiveFrom) })}</span>
                <span dir="ltr" className="text-text-primary">{usd(c.monthlyCostUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
