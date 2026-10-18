"use client";

import { useState } from "react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { FulfilmentKind } from "@/lib/catalog-api";
import { usePricedIn } from "../_lib/surface";
import { useRowKeys } from "../../_hooks/useRowKeys";
import { Select } from "../../_components/kit/Select";
import {
  BILLING_MODES,
  CATALOG_KEYS as K,
  QUALITY_TIERS,
  QUOTA_METRICS,
  RESET_POLICIES,
  VISIBILITIES,
  takesPanelGroup,
  quotaFromInput,
  quotaToInput,
  suggestSku,
  pricedIn,
  type Errors,
  type VariantForm,
} from "../_lib/catalog-form";
import { FirstRateFields } from "./RateCardSection";
import { PanelGroupSelect, type PanelGroups } from "./PanelGroupSelect";
import { Field } from "./catalog-ui";
import { Button, Input } from "../../_components/kit";

/**
 * A variant's fields, shared by the wizard and "new variant": what most
 * variants need (SKU, price, duration, quotas) up front, the rest behind
 * "more settings" with its defaults already right for a plain VPN plan.
 */
export function VariantFields({
  form,
  set,
  errors,
  productKey,
  kind,
  groups,
}: {
  form: VariantForm;
  set: <F extends keyof VariantForm>(k: F, v: VariantForm[F]) => void;
  errors: Errors<VariantForm>;
  productKey: string;
  kind: FulfilmentKind;
  /** What this variant may name; only asked of a `network_access` one (F-026-o). */
  groups: PanelGroups;
}) {
  const { t } = useLocale();
  const currency = usePricedIn();
  const [advanced, setAdvanced] = useState(false);
  const metered = form.billingMode === "metered";
  const setQuota = (i: number, patch: Partial<VariantForm["quotas"][number]>) => set("quotas", form.quotas.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const quotaKeys = useRowKeys(form.quotas);

  return (
    <div className="flex flex-col gap-3">
      {/* The billing mode leads, not under "advanced": it decides what the price means and whether a rate is asked. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common", K.variant.billingMode)} hint={t("common", K.variantHint.billingMode)}>
          <Select value={form.billingMode} onChange={(v) => set("billingMode", v as VariantForm["billingMode"])} options={BILLING_MODES.map((m) => ({ value: m, label: t("common", K.billingMode[m]) }))} />
        </Field>
        {metered ? (
          <Field label={pricedIn(t("common", K.variant.meteredPrice), currency)} error={errors.price} hint={t("common", K.variant.meteredPriceHint)}>
            <Input dir="ltr" inputMode="decimal" placeholder="0" value={form.price} onChange={(e) => set("price", e.target.value)} />
          </Field>
        ) : (
          <Field label={pricedIn(t("common", K.variant.price), currency)} error={errors.price}>
            <Input dir="ltr" inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} />
          </Field>
        )}
      </div>
      {metered && (
        <FirstRateFields
          mode={form.rateMode}
          price={form.ratePerGb}
          error={errors.ratePerGb}
          onMode={(m) => set("rateMode", m)}
          onPrice={(p) => set("ratePerGb", p)}
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common", K.variant.durationDays)} error={errors.durationDays} hint={t("common", K.variant.durationHint)}>
          <Input dir="ltr" inputMode="numeric" value={form.durationDays} onChange={(e) => set("durationDays", e.target.value)} />
        </Field>
        <Field label={t("common", K.variant.sku)} error={errors.sku} hint={t("common", K.variant.skuHint)}>
          <span className="flex gap-1">
            <Input dir="ltr" value={form.sku} onChange={(e) => set("sku", e.target.value.toUpperCase())} />
            <Button variant="quiet" size="sm" onClick={() => set("sku", suggestSku(productKey, form.durationDays))} icon={<Sparkles size={14} aria-hidden />}>
              {t("common", K.wizard.suggestSku)}
            </Button>
          </span>
        </Field>
      </div>

      {takesPanelGroup(kind) && <PanelGroupSelect value={form.panelGroupId} groups={groups} onChange={(id) => set("panelGroupId", id)} />}

      {/* The card's box (SalesCapSection) from the first moment; blank = no cap (F-513-e). */}
      <Field label={t("common", K.salesCap.label)} error={errors.salesCap} hint={t("common", K.salesCap.hint)}>
        <Input dir="ltr" inputMode="numeric" value={form.salesCap} onChange={(e) => set("salesCap", e.target.value)} />
      </Field>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-bold text-text-secondary">{t("common", K.variant.quotas)}</p>
        <p className="text-2xs text-text-secondary">{t("common", K.variantHint.quotas)}</p>
        {form.quotas.map((q, i) => (
          <div key={quotaKeys[i]} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Select
              ariaLabel={t("common", K.variant.metric)}
              value={q.metric}
              onChange={(v) => setQuota(i, { metric: v as typeof q.metric, limit: "" })}
              options={QUOTA_METRICS.map((m) => ({ value: m, label: t("common", K.metric[m]) }))}
            />
            <Input
              dir="ltr"
              inputMode="numeric"
              aria-label={t("common", K.variant.limit)}
              placeholder={t("common", K.variant.limit)}
              value={quotaToInput(q.metric, q.limit)}
              onChange={(e) => setQuota(i, { limit: quotaFromInput(q.metric, e.target.value) })}
            />
            <Select
              ariaLabel={t("common", K.variant.resetPolicy)}
              value={q.resetPolicy}
              onChange={(v) => setQuota(i, { resetPolicy: v as typeof q.resetPolicy })}
              options={RESET_POLICIES.map((m) => ({ value: m, label: t("common", K.resetPolicy[m]) }))}
            />
            <Button variant="quiet" size="sm" onClick={() => set("quotas", form.quotas.filter((_, j) => j !== i))}>{t("common", K.variant.remove)}</Button>
          </div>
        ))}
        {errors.quotas && <p className="text-2xs text-error">{t("common", errors.quotas)}</p>}
        {form.quotas.length < QUOTA_METRICS.length && (
          <Button
            variant="quiet"
            size="sm"
            className="self-start"
            onClick={() => {
              const free = QUOTA_METRICS.find((m) => !form.quotas.some((q) => q.metric === m)) ?? "traffic_bytes";
              set("quotas", [...form.quotas, { metric: free, limit: "", resetPolicy: "none" }]);
            }}
            icon={<Plus size={14} aria-hidden />}
          >
            {t("common", K.variant.addQuota)}
          </Button>
        )}
      </div>

      <Button variant="quiet" size="sm" className="self-start" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} icon={<ChevronDown size={14} className={advanced ? "rotate-180" : ""} aria-hidden />}>
        {t("common", K.wizard.advanced)}
      </Button>
      {advanced && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("common", K.variant.visibility)} hint={t("common", K.variantHint.visibility)}>
            <Select value={form.visibility} onChange={(v) => set("visibility", v as VariantForm["visibility"])} options={VISIBILITIES.map((m) => ({ value: m, label: t("common", K.visibility[m]) }))} />
          </Field>
          <Field label={t("common", K.variant.qualityTier)}>
            <Select value={form.qualityTier} onChange={(v) => set("qualityTier", v as VariantForm["qualityTier"])} options={QUALITY_TIERS.map((m) => ({ value: m, label: t("common", K.qualityTier[m]) }))} />
          </Field>
        </div>
      )}
    </div>
  );
}
