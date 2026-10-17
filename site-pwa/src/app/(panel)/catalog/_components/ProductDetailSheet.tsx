"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, Plus, Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { type CatalogCapability, type CatalogCategory, type CatalogPrice, type CatalogProduct, type CatalogProductDetail, type FulfilmentKind } from "@/lib/catalog-api";
import { PricingCurrencyContext, useCatalogSurface, usePricedIn, usePricingCurrency } from "../_lib/surface";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { useRowKeys } from "../../_hooks/useRowKeys";
import { Select } from "../../_components/kit/Select";
import { formatMoney } from "../../_lib/money";
import {
  BILLING_MODES,
  CATALOG_KEYS as K,
  QUALITY_TIERS,
  QUOTA_METRICS,
  RESET_POLICIES,
  VISIBILITIES,
  capabilitiesFor,
  surfaceActor,
  emptyVariantForm,
  groupsForVariant,
  takesPanelGroup,
  quotaFromInput,
  quotaToInput,
  suggestSku,
  pricedIn,
  validateVariantForm,
  variantBody,
  type Errors,
  type VariantForm,
} from "../_lib/catalog-form";
import { CapabilityPicker } from "./CapabilityPicker";
import { FirstRateFields } from "./RateCardSection";
import { ProductCategories } from "./CategoryPickers";
import { ProductAudienceSection, ownsAudience } from "./ProductAudienceSection";
import { PanelGroupSelect, usePanelGroups, type PanelGroups } from "./PanelGroupSelect";
import { VariantCard } from "./VariantCard";
import { Field, Sheet, useMessage } from "./catalog-ui";
import { Alert, Button, Input } from "../../_components/kit";
import { isPlatformTenant } from "@/lib/tenant-type";

/**
 * One product: what it unlocks (editable with the picker), and each variant
 * with its price history and a new price (F-026-f). Nothing is patched from a
 * write's answer — the product is re-read.
 */
export function ProductDetailSheet({
  product,
  name,
  capabilities,
  capabilityLabel,
  onCapabilityCreated,
  categories,
  categoryLabel,
  onClose,
  onChanged,
}: {
  product: CatalogProduct;
  name: string;
  /** Every capability the caller sees; the picker offers those this product's tenant may carry. */
  capabilities: readonly CatalogCapability[];
  capabilityLabel: (c: CatalogCapability) => string;
  onCapabilityCreated: () => Promise<void>;
  /** Where it can be filed; its own list is `product.categoryIds` (F-026-s). */
  categories: readonly CatalogCategory[];
  categoryLabel: (c: CatalogCategory) => string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t, lang } = useLocale();
  const message = useMessage();
  const { api, tenantId: surfaceTenantId } = useCatalogSurface();
  const { me } = usePanelSession();
  const [detail, setDetail] = useState<CatalogProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const kind = product.fulfilmentKind;
  const groups = usePanelGroups(takesPanelGroup(kind));
  const offered = { ...groups, options: groupsForVariant(groups.options, product.tenantId) };

  const load = useCallback(async () => {
    try {
      setDetail(await api.product(product.id));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
    // `message` is rebuilt each render; the product is what decides a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const money = (price: CatalogPrice) => formatMoney(price.amount, price.currencyCode, { lang, t });
  const currency = usePricingCurrency(product.tenantId);

  const sheet = (
    <Sheet
      title={
        <span className="flex flex-col">
          {name}
          <span className="text-2xs font-normal text-text-secondary">
            <span dir="ltr">{product.key}</span> · {t("common", K.fulfilmentKind[product.fulfilmentKind])}
          </span>
        </span>
      }
      onClose={onClose}
    >
      <ProductCategories product={detail ?? product} categories={categories} label={categoryLabel} onSaved={async () => Promise.all([load(), onChanged()]).then(() => undefined)} />
      <Capabilities
        product={detail ?? product}
        capabilities={capabilities}
        label={capabilityLabel}
        onCreated={onCapabilityCreated}
        onSaved={async () => Promise.all([load(), onChanged()]).then(() => undefined)} />
      {detail && ownsAudience(detail, surfaceTenantId, me?.tenant.id ?? null) && (
        <ProductAudienceSection key={detail.id} product={detail} onSaved={onChanged} />
      )}

      <h3 className="text-xs font-bold text-text-secondary">{t("common", K.open)}</h3>
      {error && <Alert tone="error">{error}</Alert>}
      {!detail && !error && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.loading)}
        </p>
      )}
      {detail?.variants.length === 0 && !adding && <p className="rounded-xl bg-[var(--leaf-bg)] p-3 text-xs text-text-primary">{t("common", K.wizard.skipVariant)}</p>}
      {detail?.variants.map((v) => (
        <VariantCard key={v.id} variant={v} kind={kind} groups={offered} money={money} onChanged={load} />
      ))}
      {detail &&
        (adding ? (
          <NewVariant
            productId={product.id}
            productKey={product.key}
            kind={kind}
            groups={offered}
            onCancel={() => setAdding(false)}
            onSaved={async () => {
              setAdding(false);
              await load();
            }}
          />
        ) : (
          <Button variant="primary" size="sm" className="self-start" onClick={() => setAdding(true)} icon={<Plus size={14} aria-hidden />}>
            {t("common", K.newVariant)}
          </Button>
        ))}
    </Sheet>
  );
  return <PricingCurrencyContext.Provider value={currency}>{sheet}</PricingCurrencyContext.Provider>;
}

function Capabilities({
  product,
  capabilities,
  label,
  onCreated,
  onSaved,
}: {
  product: CatalogProduct;
  capabilities: readonly CatalogCapability[];
  label: (c: CatalogCapability) => string;
  onCreated: () => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const message = useMessage();
  const { api, tenantId } = useCatalogSurface();
  const { me } = usePanelSession();
  // Only the platform owner names whose a new capability is; a reseller's screen's schema refuses a `tenantId`.
  const owner = isPlatformTenant(surfaceActor(me, tenantId)?.tenant?.type);
  const nameOf = (k: string) => {
    const c = capabilities.find((x) => x.key === k);
    return c ? label(c) : k;
  };
  const [editing, setEditing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <section className="flex flex-col gap-2 rounded-2xl border border-card-border p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold text-text-secondary">{t("common", K.capabilities.label)}</p>
          <Button variant="quiet" size="sm" onClick={() => setEditing([...product.featureKeys])}>
            {t("common", K.capabilities.edit)}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {product.featureKeys.length === 0 ? (
            <span className="text-2xs text-text-secondary">{t("common", K.wizard.none)}</span>
          ) : (
            product.featureKeys.map((k) => (
              <span key={k} title={k} className="rounded-full bg-[var(--leaf-bg)] px-2.5 py-1 text-2xs font-bold text-primary">
                {nameOf(k)}
              </span>
            ))
          )}
        </div>
      </section>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateProduct(product.id, { featureKeys: editing });
      setEditing(null);
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-dashed border-primary p-3">
      <CapabilityPicker
        value={editing}
        onChange={setEditing}
        options={capabilitiesFor(capabilities, product.tenantId)}
        label={label}
        takenKeys={capabilities.map((c) => c.key)}
        newTenant={owner ? product.tenantId : undefined}
        onCreated={onCreated}
      />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" size="sm" onClick={() => setEditing(null)}>
          {t("common", K.cancel)}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
          {t("common", K.capabilities.save)}
        </Button>
      </div>
    </section>
  );
}

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

function NewVariant({
  productId,
  productKey,
  kind,
  groups,
  onCancel,
  onSaved,
}: {
  productId: string;
  productKey: string;
  kind: FulfilmentKind;
  groups: PanelGroups;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const message = useMessage();
  const { api } = useCatalogSurface();
  const [form, setForm] = useState<VariantForm>(emptyVariantForm);
  const [errors, setErrors] = useState<Errors<VariantForm>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <F extends keyof VariantForm>(k: F, v: VariantForm[F]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const withSku = form.sku.trim() ? form : { ...form, sku: suggestSku(productKey, form.durationDays) };
    setForm(withSku);
    const found = validateVariantForm(withSku);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    try {
      await api.createVariant(productId, variantBody(withSku, kind));
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-dashed border-primary p-3">
      <VariantFields form={form} set={set} errors={errors} productKey={productKey} kind={kind} groups={groups} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" size="sm" onClick={onCancel}>
          {t("common", K.cancel)}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
          {t("common", K.save)}
        </Button>
      </div>
    </section>
  );
}

/** Where the wizard has always taken it from (F-026-p). */
export { usePanelGroups };
