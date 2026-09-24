"use client";

import { useState } from "react";
import { Check, Loader2, Receipt } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useGatewayMessage, type GatewaySurface } from "../_lib/surface";
import { taxRateError } from "../_lib/gateway-form";
import { Field, TextInput } from "./gateway-fields";

const X = FrontendI18nKeys.common.gateways.tax;

/**
 * The tenant's default tax on a top-up (F-104-aj over F-104-ag, ADR-0076),
 * beside the quick amounts it sits with on `billing.deposit_setting`. A
 * gateway's own rate, set in its form, overrides this one. Empty saves `null`:
 * no tax. The rate is judged by `taxRateError`, the same function the gateway
 * form uses, so a value refused there is refused here before the request.
 */
export function DepositTaxCard({ surface, initial }: { surface: GatewaySurface; initial: string | null }) {
  const { t } = useLocale();
  const errorMessage = useGatewayMessage(surface);
  const [rate, setRate] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const error = taxRateError(rate);
  const dirty = rate.trim() !== saved;

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const { taxRatePercent } = await surface.api.setTax(rate.trim() || null);
      setRate(taxRatePercent ?? "");
      setSaved(taxRatePercent ?? "");
      setDone(true);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-leaf-bg text-primary">
          <Receipt size={18} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-text-primary">{t("common", X.title)}</h2>
          <p className="text-xs leading-6 text-text-secondary">{t("common", X.subtitle)}</p>
        </div>
      </div>

      <div className="max-w-xs">
        <Field id="default-tax" label={t("common", X.defaultTitle)} error={error} hint={t("common", X.defaultHint)} optional>
          <TextInput
            id="default-tax"
            value={rate}
            onChange={(v) => {
              setRate(v);
              setDone(false);
            }}
            invalid={Boolean(error)}
            ltr
            decimal
            suffix="%"
            placeholder={t("common", X.none)}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        {failure && (
          <p role="alert" className="me-auto text-xs font-bold text-error">
            {failure}
          </p>
        )}
        {done && !dirty && (
          <p role="status" className="me-auto inline-flex items-center gap-1 text-xs font-bold text-success">
            <Check size={14} aria-hidden />
            {t("common", X.saved)}
          </p>
        )}
        <button
          type="button"
          disabled={!dirty || saving || Boolean(error)}
          onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("common", saving ? X.saving : X.save)}
        </button>
      </div>
    </section>
  );
}
