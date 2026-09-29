"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { tenantApi, type TenantPackage } from "@/lib/tenant-api";
import { Alert, Field, Sheet, input, primaryButton, useMessage } from "../../_components/resellers-ui";
import type { Errors } from "../../_lib/resellers";
import {
  PACKAGE_FEATURE_KEYS,
  PACKAGE_KEYS as K,
  WHOLESALE_METERS,
  createPackageBody,
  emptyPackageForm,
  otherRates,
  packageFormOf,
  updatePackageBody,
  validatePackage,
  type PackageForm,
} from "../../_lib/packages";

/**
 * Creating or editing one package (F-018-d, F-118-n5): name, the two prices,
 * the features it includes and the wholesale price per GiB of VPN traffic
 * (F-118-n1). An edit sends only what changed; a rate is history at the
 * service, so a new price reaches Grants sold from now on and never one already
 * sold (F-118-n2). `currency` is the platform's: a new package is priced in it.
 */
export function PackageSheet({
  pkg,
  currency,
  onClose,
  onSaved,
}: {
  pkg: TenantPackage | null;
  currency: string;
  onClose: () => void;
  onSaved: (p: TenantPackage, created: boolean) => void;
}) {
  const { t } = useLocale();
  const message = useMessage();
  const [form, setForm] = useState<PackageForm>(() => (pkg ? packageFormOf(pkg) : emptyPackageForm()));
  const [errors, setErrors] = useState<Errors<PackageForm>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PackageForm>) => setForm((f) => ({ ...f, ...patch }));
  const code = pkg?.currencyCode ?? currency;
  const others = pkg ? otherRates(pkg) : [];

  const toggle = (key: string) =>
    set({ featureKeys: form.featureKeys.includes(key) ? form.featureKeys.filter((k) => k !== key) : [...form.featureKeys, key] });

  async function submit() {
    const found = validatePackage(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    const body = pkg ? updatePackageBody(pkg, form) : null;
    if (pkg && !body) {
      setFailure(t("common", K.form.nothingChanged));
      return;
    }
    setBusy(true);
    try {
      const saved = pkg && body ? await tenantApi.updatePackage(pkg.id, body) : await tenantApi.createPackage(createPackageBody(form));
      onSaved(saved, !pkg);
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={pkg ? t("common", K.form.editTitle, { name: pkg.name }) : t("common", K.form.createTitle)}
      onClose={onClose}
      footer={
        <button type="button" className={primaryButton} disabled={busy} onClick={submit}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("common", pkg ? K.form.save : K.form.submit)}
        </button>
      }
    >
      <Field label={t("common", K.form.name)} error={errors.name}>
        <input className={input} value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("common", K.form.monthly, { currency: code })} error={errors.monthlyPrice}>
          <input className={input} dir="ltr" inputMode="decimal" value={form.monthlyPrice} onChange={(e) => set({ monthlyPrice: e.target.value })} />
        </Field>
        <Field label={t("common", K.form.yearly, { currency: code })} error={errors.yearlyPrice}>
          <input className={input} dir="ltr" inputMode="decimal" value={form.yearlyPrice} onChange={(e) => set({ yearlyPrice: e.target.value })} />
        </Field>
      </div>
      <p className="-mt-2 text-[11px] text-text-secondary">{t("common", K.form.priceHint)}</p>

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

      {WHOLESALE_METERS.map((m) => (
        <Field key={m.meterKey} label={t("common", K.form.rate, { currency: code })} hint={t("common", K.form.rateHint)} error={errors.rates}>
          <input
            className={input}
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
            <p key={`${r.meterKey}|${r.unitSize}`} dir="ltr">
              {t("common", K.otherRate, { meter: r.meterKey, price: r.unitPrice, currency: r.currencyCode, size: r.unitSize })}
            </p>
          ))}
        </div>
      )}
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}
