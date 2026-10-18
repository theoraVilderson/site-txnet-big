"use client";

import { Check } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { PackageMeterRate } from "@/lib/tenant-api";
import { Field } from "../../_components/resellers-ui";
import type { Errors } from "../../_lib/resellers";
import { PACKAGE_FEATURE_KEYS, PACKAGE_KEYS as K, WHOLESALE_METERS, badRate, type PackageForm } from "../../_lib/packages";
import { useMeterNames } from "../../../catalog/_lib/meter-names";
import { Input } from "../../../_components/kit";

/**
 * A package's fields by section (PK-1-f): a package page's sheet shows one
 * section, the new-package wizard one per step (PK-1-g). `code` is the currency the prices are asked in.
 */
type FieldsProps = { form: PackageForm; set: (patch: Partial<PackageForm>) => void; errors: Errors<PackageForm>; code: string };

/** The name and the two prices: the page's basics sheet. */
export function BasicsFields(props: FieldsProps) {
  return (
    <>
      <NameField {...props} />
      <PriceFields {...props} />
    </>
  );
}

/** The name, in the language the text is written in (`dir`). */
export function NameField({ form, set, errors, dir }: Pick<FieldsProps, "form" | "set" | "errors"> & { dir?: string }) {
  const { t } = useLocale();
  return (
    <Field label={t("common", K.form.name)} error={errors.name}>
      <Input dir={dir} value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
    </Field>
  );
}

/** The two prices, in `code`; at least one is needed. */
export function PriceFields({ form, set, errors, code }: FieldsProps) {
  const { t } = useLocale();
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("common", K.form.monthly, { currency: code })} error={errors.monthlyPrice}>
          <Input dir="ltr" inputMode="decimal" value={form.monthlyPrice} onChange={(e) => set({ monthlyPrice: e.target.value })} />
        </Field>
        <Field label={t("common", K.form.yearly, { currency: code })} error={errors.yearlyPrice}>
          <Input dir="ltr" inputMode="decimal" value={form.yearlyPrice} onChange={(e) => set({ yearlyPrice: e.target.value })} />
        </Field>
      </div>
      <p className="-mt-2 text-2xs text-text-secondary">{t("common", K.form.priceHint)}</p>
    </>
  );
}

/** The features it includes, as toggles. */
export function FeatureFields({ form, set }: Pick<FieldsProps, "form" | "set">) {
  const { t } = useLocale();
  const toggle = (key: string) =>
    set({ featureKeys: form.featureKeys.includes(key) ? form.featureKeys.filter((k) => k !== key) : [...form.featureKeys, key] });
  return (
    <Field label={t("common", K.form.features)}>
      <div className="flex flex-wrap gap-2">
        {PACKAGE_FEATURE_KEYS.map((key) => {
          const on = form.featureKeys.includes(key);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(key)}
              className={`inline-flex items-center gap-1 rounded-xl border px-3 py-1.5 text-xs font-bold ${
                on ? "border-primary bg-leaf-bg text-primary" : "border-card-border text-text-secondary hover:text-text-primary"
              }`}
            >
              {on && <Check size={12} aria-hidden />}
              {t("common", K.features[key])}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** The wholesale rates this form asks for (`WHOLESALE_METERS`), and the ones in force it leaves alone (`others`). */
export function RateFields({ form, set, errors, code, others }: FieldsProps & { others: PackageMeterRate[] }) {
  const { t } = useLocale();
  const meterName = useMeterNames();
  return (
    <>
      {WHOLESALE_METERS.map((m) => (
        <Field
          key={m.meterKey}
          label={t("common", m.label, { meter: meterName(m.meterKey), currency: code })}
          hint={t("common", m.hint)}
          error={errors.rates && badRate(form.rates[m.meterKey]) ? errors.rates : undefined}
        >
          <Input
            dir="ltr"
            inputMode="decimal"
            value={form.rates[m.meterKey]}
            onChange={(e) => set({ rates: { ...form.rates, [m.meterKey]: e.target.value } })}
          />
        </Field>
      ))}

      {others.length > 0 && (
        <div className="space-y-1 rounded-xl border border-card-border p-3 text-xs text-text-secondary">
          <p className="font-bold">{t("common", K.form.otherRates)}</p>
          {others.map((r) => (
            <p key={`${r.meterKey}|${r.unitSize}`} dir="auto">
              {t("common", K.otherRate, { meter: meterName(r.meterKey), price: r.unitPrice, currency: r.currencyCode, size: r.unitSize })}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
