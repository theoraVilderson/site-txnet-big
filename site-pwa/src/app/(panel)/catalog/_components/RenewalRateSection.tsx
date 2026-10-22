"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2, Power } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { renewalRateApi, type RenewalRateRow, type RenewalRates } from "@/lib/catalog-renewal-rates";
import { Alert, Button, Input } from "../../_components/kit";
import { DataTable } from "../../_components/kit/DataTable";
import { DatePicker } from "../../_components/kit/DatePicker";
import { formatInstant, platformToday } from "../../_lib/datetime";
import { currencyDecimals, formatMoney } from "../../_lib/money";
import { CATALOG_KEYS as K, pricedIn, rateDecimals, type Errors } from "../_lib/catalog-form";
import { emptyRenewalRateForm, isScheduled, renewalFrom, renewalRateBody, validateRenewalRateForm, type RenewalRateForm } from "../_lib/renewal-rate";
import { useCatalogSurface, usePricedIn } from "../_lib/surface";
import { Field, useMessage } from "./catalog-ui";

const RR = FrontendI18nKeys.common.catalog.renewalRate;

/** The six number fields, in the order they sit: each part's price, then its fewest and most. */
const FIELDS = [
  ["pricePerGib", RR.pricePerGib],
  ["minGib", RR.minGib],
  ["maxGib", RR.maxGib],
  ["pricePerDay", RR.pricePerDay],
  ["minDays", RR.minDays],
  ["maxDays", RR.maxDays],
] as const;

/**
 * A product's renewal rate on its editor (F-305-g, panel-web
 * `contract.renewal.md` "The seller's rate", over catalog
 * `contract.renewal-rate.md`): the rate in effect, a new one from now or a
 * later day, «خاموش» as its own row, and the history newest first. A rate is
 * history as a price is, so nothing here edits a row. Written in the tenant's
 * pricing currency, named beside each price. On the surface's own tenant or
 * the reseller its path names; a reseller never reaches a platform product's.
 */
export function RenewalRateSection({ productId }: { productId: string }) {
  const { t, lang } = useLocale();
  const message = useMessage();
  const currency = usePricedIn();
  const { tenantId } = useCatalogSurface();
  const [rates, setRates] = useState<RenewalRates | null>(null);
  const [asked, setAsked] = useState(0);
  const [form, setForm] = useState<RenewalRateForm>(emptyRenewalRateForm);
  const [errors, setErrors] = useState<Errors<RenewalRateForm>>({});
  // The refusal as it came; worded at render, in the language shown then.
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);

  useEffect(() => {
    let alive = true;
    renewalRateApi(tenantId)
      .list(productId)
      .then(
        (answer) => alive && setRates(answer),
        (e: unknown) => alive && setError(e),
      );
    return () => {
      alive = false;
    };
  }, [productId, tenantId, asked]);

  /** One write, then a re-read: nothing is patched from the answer. */
  const write = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      setForm(emptyRenewalRateForm());
      setAsked((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const today = platformToday();
    const found = validateRenewalRateForm(form, today);
    setErrors(found);
    if (Object.keys(found).length === 0) void write(() => renewalRateApi(tenantId).set(productId, renewalRateBody(form, today)));
  };

  const turnOff = () => {
    const today = platformToday();
    const pastDay = form.day !== "" && form.day < today;
    setErrors(pastDay ? { day: K.errors.pastDay } : {});
    if (!pastDay) void write(() => renewalRateApi(tenantId).off(productId, renewalFrom(form.day, today)));
  };

  const price = (amount: string, code: string) => formatMoney(amount, code, { lang, t }, { decimals: rateDecimals(amount, currencyDecimals(code)) });
  /** One row in words: off, or each part sold with its price and bounds. */
  const summary = (row: RenewalRateRow) => {
    if (row.isOff) return t("common", RR.off);
    const parts = [];
    if (row.pricePerGib !== null && (row.maxGib ?? 0) > 0) parts.push(t("common", RR.perGib, { price: price(row.pricePerGib, row.currencyCode), min: row.minGib ?? 0, max: row.maxGib ?? 0 }));
    if (row.pricePerDay !== null && (row.maxDays ?? 0) > 0) parts.push(t("common", RR.perDay, { price: price(row.pricePerDay, row.currencyCode), min: row.minDays ?? 0, max: row.maxDays ?? 0 }));
    return parts.join(" · ");
  };
  const now = new Date();

  return (
    <section aria-label={t("common", RR.title)} className="flex flex-col gap-3 rounded-2xl border border-card-border p-3">
      <div>
        <p className="text-xs font-bold text-text-secondary">{t("common", RR.title)}</p>
        <p className="mt-1 text-2xs leading-5 text-text-secondary">{t("common", RR.hint)}</p>
      </div>
      {rates === null && error === null ? (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.loading)}
        </p>
      ) : (
        rates && (
          <p className="text-xs font-bold text-text-primary">
            {t("common", RR.inEffect)}: <span dir="auto">{rates.inEffect ? summary(rates.inEffect) : t("common", RR.none)}</span>
          </p>
        )
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        {FIELDS.map(([field, label]) => (
          <Field key={field} label={field.startsWith("price") ? pricedIn(t("common", label), currency) : t("common", label)} error={errors[field]}>
            <Input dir="ltr" inputMode={field.startsWith("price") ? "decimal" : "numeric"} value={form[field]} onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))} />
          </Field>
        ))}
      </div>
      <p className="text-2xs text-text-secondary">{t("common", RR.boundsHint)}</p>
      <Field label={t("common", K.price.day)} error={errors.day} hint={t("common", K.price.dayHint)}>
        <DatePicker value={form.day || null} onChange={(d) => setForm((f) => ({ ...f, day: d ?? "" }))} />
      </Field>
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="quiet" size="sm" disabled={busy} onClick={turnOff} icon={<Power size={14} aria-hidden />}>
          {t("common", RR.turnOff)}
        </Button>
        <Button variant="primary" size="sm" loading={busy} onClick={save}>
          {t("common", RR.save)}
        </Button>
      </div>

      {rates && rates.history.length > 0 && (
        <>
          <Button variant="quiet" size="sm" className="self-start" aria-expanded={history} onClick={() => setHistory((h) => !h)} icon={<ChevronDown size={14} className={history ? "rotate-180" : ""} aria-hidden />}>
            {t("common", RR.history)} ({rates.history.length})
          </Button>
          {history && (
            <DataTable
              label={t("common", RR.history)}
              compact
              bare
              rows={rates.history}
              rowKey={(r) => r.id}
              columns={[
                { id: "rate", header: t("common", RR.inEffect), cell: summary },
                { id: "from", header: t("common", K.price.day), cell: (r) => t("common", K.price.effectiveFrom, { time: formatInstant(r.effectiveFrom, lang) ?? "" }) },
                {
                  id: "state",
                  header: t("common", K.price.state),
                  cell: (r) => (r.id === rates.inEffect?.id ? t("common", K.price.current) : isScheduled(r, now) ? t("common", K.price.scheduled) : ""),
                },
              ]}
            />
          )}
        </>
      )}
    </section>
  );
}
