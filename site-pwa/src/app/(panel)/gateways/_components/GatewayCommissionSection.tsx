"use client";

import { useCallback, useEffect, useState } from "react";
import { Percent } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import type { AdminGateway, CommissionHistory } from "@/lib/billing-api";
import { displayZone } from "@/lib/time-zone";
import { Badge, Button, Field, Input, notify } from "../../_components/kit";
import { DatePicker } from "../../_components/kit/DatePicker";
import { dayIn, formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { commissionBodyOf, type CommissionForm } from "../_lib/commission";
import { useGatewayMessage, type GatewaySurface } from "../_lib/surface";

const C = FrontendI18nKeys.common.gateways.commission;

/** A tenant day at noon UTC, so its label is that day on every wall clock. */
const noonOf = (day: string) => `${day}T12:00:00Z`;

/**
 * What the gateway's provider deducts from each payment (F-1001-w; billing
 * `contract.analytics-expenses.md` "Gateway commission"): the row in effect,
 * the history newest first, and a form that adds a row from a day on — there
 * is no edit, and 0 and 0 stops counting one. The Profit tab counts it as a
 * cost, less the fee the payer was charged. Its own save on its own route,
 * never part of the editor's "what changed".
 *
 * Billing is the judge of who may see it: the platform's staff in a
 * reseller's workspace are refused `not_allowed` (a reseller's costs are its
 * own), and the section is then not shown at all.
 */
export function GatewayCommissionSection({ gateway, surface }: { gateway: AdminGateway; surface: GatewaySurface }) {
  const { t, lang } = useLocale();
  const errorMessage = useGatewayMessage(surface);
  const [today] = useState(() => dayIn(Date.now(), displayZone()));
  const [history, setHistory] = useState<CommissionHistory | null>(null);
  const [hidden, setHidden] = useState(false);
  const [form, setForm] = useState<CommissionForm>({ percent: "", fixedAmount: "", effectiveFrom: today });
  const [saving, setSaving] = useState(false);
  // Billing's refusal of this form stays beside it, never a toast (kit K10).
  const [refusal, setRefusal] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(() => {
    surface.api.commission(gateway.source, gateway.id).then(setHistory, (e: unknown) => {
      if (e instanceof ApiError && e.reason === "not_allowed") setHidden(true);
      else setLoadError(e);
    });
  }, [surface.api, gateway.source, gateway.id]);
  useEffect(load, [load]);

  if (hidden) return null;
  const checked = commissionBodyOf(form);
  const fieldError = (field: "percent" | "fixedAmount") => ("error" in checked && checked.error === field ? t("common", C.errors[field]) : undefined);
  const day = (d: string) => formatInstant(noonOf(d), lang, { withTime: false }) ?? d;
  const currency = history?.currencyCode ?? "";
  const rate = (r: { percent: string; fixedAmount: string; currencyCode: string }) =>
    t("common", C.rate, { percent: r.percent, fixed: formatMoney(r.fixedAmount, r.currencyCode, { lang, t }) });

  const add = async () => {
    if (!("body" in checked)) return;
    setSaving(true);
    setRefusal(null);
    try {
      await surface.api.addCommission(gateway.source, gateway.id, checked.body);
      notify.success(t("common", C.added));
      setForm({ percent: "", fixedAmount: "", effectiveFrom: today });
      load();
    } catch (e) {
      setRefusal(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="gw-section-commission" className="flex scroll-mt-4 flex-col gap-3 rounded-2xl border border-card-border bg-card-bg p-4 sm:p-5">
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-leaf-bg text-primary">
          <Percent size={18} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-text-primary">{t("common", C.title)}</h3>
          <p className="text-2xs leading-5 text-text-secondary">{t("common", C.subtitle)}</p>
        </div>
      </header>

      {history && history.commissions.length === 0 && <p className="text-xs text-text-secondary">{t("common", C.none)}</p>}
      {history && history.commissions.length > 0 && (
        <ul aria-label={t("common", C.history)} className="divide-y divide-card-border">
          {history.commissions.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
              <span className="flex flex-col gap-0.5">
                <span dir="ltr" className="font-bold text-text-primary">{rate(c)}</span>
                <span className="text-text-secondary">{t("common", C.from, { day: day(c.effectiveFrom) })}</span>
              </span>
              {c.id === history.inEffect ? <Badge tone="success">{t("common", C.inEffect)}</Badge> : c.effectiveFrom > today && <Badge tone="neutral">{t("common", C.scheduled)}</Badge>}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t("common", C.percent)} error={fieldError("percent")}>
          <Input inputMode="decimal" dir="ltr" value={form.percent} placeholder="0" onChange={(e) => setForm({ ...form, percent: e.target.value })} />
        </Field>
        <Field label={t("common", C.fixedAmount, { currency })} error={fieldError("fixedAmount")}>
          <Input inputMode="decimal" dir="ltr" value={form.fixedAmount} placeholder="0" onChange={(e) => setForm({ ...form, fixedAmount: e.target.value })} />
        </Field>
        <DatePicker label={t("common", C.effectiveFrom)} value={form.effectiveFrom} onChange={(effectiveFrom) => setForm({ ...form, effectiveFrom })} />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {(refusal || loadError !== null) && (
          <p role="alert" className="me-auto text-xs font-bold text-error">
            {refusal ?? errorMessage(loadError)}
          </p>
        )}
        <Button variant="primary" size="sm" disabled={!("body" in checked) || saving} loading={saving} onClick={() => void add()}>
          {t("common", C.add)}
        </Button>
      </div>
    </section>
  );
}
