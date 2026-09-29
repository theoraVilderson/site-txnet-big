"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogRateCard, CatalogVariant } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { useMeterNames } from "../_lib/meter-names";
import { DatePicker } from "../../_components/kit/DatePicker";
import { Select } from "../../_components/kit/Select";
import { currencyDecimals, formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import {
  CATALOG_KEYS as K,
  RATE_CARD_MODES,
  VPN_TRAFFIC,
  currentRateCard,
  rateCardBody,
  rateDecimals,
  tehranToday,
  validateRateCardForm,
  type Errors,
  type RateCardForm,
} from "../_lib/catalog-form";
import { Field, input, primaryButton, quietButton } from "./catalog-ui";

/**
 * A metered variant's rate per GB of traffic (F-118-m, ADR-0105 decision 10):
 * the card in effect, a new one — mode and price, from now or a later day —
 * and the history, each switchable off. A card is history as a price is, so
 * nothing here edits one. The platform's cards never reach a reseller's
 * screen: billing answers only the variants this surface owns.
 */
export function RateCardSection({ variant: v, act }: { variant: CatalogVariant; act: (run: () => Promise<unknown>) => Promise<void> }) {
  const { t, lang } = useLocale();
  const { api } = useCatalogSurface();
  const meterName = useMeterNames();
  const [form, setForm] = useState<RateCardForm>({ mode: "prepaid", unitPrice: "", day: "" });
  const [errors, setErrors] = useState<Errors<RateCardForm>>({});
  const [history, setHistory] = useState(false);
  const now = new Date();
  const cards = v.rateCards.filter((c) => c.meterKey === VPN_TRAFFIC);
  const current = currentRateCard(cards, now);

  const rate = (c: CatalogRateCard) =>
    t("common", K.rateCard.perGbShown, {
      price: formatMoney(c.unitPrice, c.currencyCode, { lang, t }, { decimals: rateDecimals(c.unitPrice, currencyDecimals(c.currencyCode)) }),
    });

  const newRate = async () => {
    const today = tehranToday();
    const found = validateRateCardForm(form, today);
    setErrors(found);
    if (Object.keys(found).length) return;
    await act(() => api.setRateCard(v.id, rateCardBody(form, today)));
    setForm((f) => ({ ...f, unitPrice: "", day: "" }));
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-[var(--leaf-bg)] p-2">
      <p className="text-xs font-bold text-text-primary">
        {t("common", K.rateCard.title, { meter: meterName(VPN_TRAFFIC) })}:{" "}
        {current ? (
          <span dir="auto">
            {rate(current)} · {t("common", K.rateCard.modes[current.mode])}
          </span>
        ) : (
          <span className="text-error">{t("common", K.rateCard.none)}</span>
        )}
      </p>

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <Field label={t("common", K.rateCard.mode)} hint={t("common", K.rateCard.modeHint)}>
          <Select
            value={form.mode}
            onChange={(m) => setForm((f) => ({ ...f, mode: m as RateCardForm["mode"] }))}
            options={RATE_CARD_MODES.map((m) => ({ value: m, label: t("common", K.rateCard.modes[m]) }))}
          />
        </Field>
        <Field label={t("common", K.rateCard.perGb)} error={errors.unitPrice}>
          <input className={input} dir="ltr" inputMode="decimal" value={form.unitPrice} onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value }))} />
        </Field>
        <Field label={t("common", K.price.day)} error={errors.day} hint={t("common", K.price.dayHint)}>
          <DatePicker value={form.day || null} onChange={(d) => setForm((f) => ({ ...f, day: d ?? "" }))} />
        </Field>
        <button type="button" className={primaryButton} onClick={() => void newRate()}>
          {t("common", K.rateCard.newRate)}
        </button>
      </div>

      <button type="button" className={`${quietButton} self-start`} aria-expanded={history} onClick={() => setHistory((h) => !h)}>
        <ChevronDown size={14} className={history ? "rotate-180" : ""} aria-hidden />
        {t("common", K.rateCard.history)} ({cards.length})
      </button>
      {history && (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <tbody className="divide-y divide-card-border text-text-primary">
              {cards.map((c) => (
                <tr key={c.id}>
                  <td className="px-2 py-1.5">{rate(c)}</td>
                  <td className="px-2 py-1.5">{t("common", K.rateCard.modes[c.mode])}</td>
                  <td className="px-2 py-1.5">{t("common", K.price.effectiveFrom, { time: formatInstant(c.effectiveFrom, lang) ?? "" })}</td>
                  <td className="px-2 py-1.5">
                    {c.id === current?.id
                      ? t("common", K.price.current)
                      : !c.isActive
                        ? t("common", K.inactive)
                        : new Date(c.effectiveFrom) > now
                          ? t("common", K.price.scheduled)
                          : ""}
                  </td>
                  <td className="px-2 py-1.5 text-end">
                    {c.isActive && (
                      <button type="button" className={quietButton} onClick={() => void act(() => api.deactivateRateCard(c.id))}>
                        {t("common", K.deactivate)}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The new-variant form's first card, shown once the variant is metered (F-118-m). */
export function FirstRateFields({
  mode,
  price,
  error,
  onMode,
  onPrice,
}: {
  mode: RateCardForm["mode"];
  price: string;
  error?: string;
  onMode: (m: RateCardForm["mode"]) => void;
  onPrice: (p: string) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t("common", K.rateCard.mode)} hint={t("common", K.rateCard.modeHint)}>
        <Select value={mode} onChange={(m) => onMode(m as RateCardForm["mode"])} options={RATE_CARD_MODES.map((m) => ({ value: m, label: t("common", K.rateCard.modes[m]) }))} />
      </Field>
      <Field label={t("common", K.rateCard.perGb)} error={error}>
        <input className={input} dir="ltr" inputMode="decimal" value={price} onChange={(e) => onPrice(e.target.value)} />
      </Field>
    </div>
  );
}
