"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, Plus, Power, Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { type CatalogCapability, type CatalogCategory, type CatalogPrice, type CatalogProduct, type CatalogProductDetail, type CatalogVariant, type FulfilmentKind, type PanelGroupOption, type Quotas } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { DatePicker } from "../../_components/kit/DatePicker";
import { Select } from "../../_components/kit/Select";
import { formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import {
  BILLING_MODES,
  CATALOG_KEYS as K,
  QUALITY_TIERS,
  QUOTA_METRICS,
  RESET_POLICIES,
  VISIBILITIES,
  capabilitiesFor,
  currentPrice,
  isPlatformOwner,
  surfaceActor,
  emptyVariantForm,
  groupsForVariant,
  notForSale,
  panelGroupPatch,
  takesPanelGroup,
  priceBody,
  quotaFromInput,
  quotaToInput,
  suggestSku,
  tehranToday,
  validatePriceForm,
  validateVariantForm,
  variantBody,
  type Errors,
  type PriceForm,
  type VariantForm,
} from "../_lib/catalog-form";
import { CapabilityPicker } from "./CapabilityPicker";
import { ProductCategories } from "./CategoryPickers";
import { Alert, CopyId, Field, Sheet, input, primaryButton, quietButton, useMessage } from "./catalog-ui";

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
  const { api } = useCatalogSurface();
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

  return (
    <Sheet
      title={
        <span className="flex flex-col">
          {name}
          <span className="text-[11px] font-normal text-text-secondary">
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

      <h3 className="text-xs font-bold text-text-secondary">{t("common", K.open)}</h3>
      {error && <Alert>{error}</Alert>}
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
          <button type="button" className={`${primaryButton} self-start`} onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden />
            {t("common", K.newVariant)}
          </button>
        ))}
    </Sheet>
  );
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
  const owner = isPlatformOwner(surfaceActor(me, tenantId));
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
          <button type="button" className={quietButton} onClick={() => setEditing([...product.featureKeys])}>
            {t("common", K.capabilities.edit)}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {product.featureKeys.length === 0 ? (
            <span className="text-[11px] text-text-secondary">{t("common", K.wizard.none)}</span>
          ) : (
            product.featureKeys.map((k) => (
              <span key={k} title={k} className="rounded-full bg-[var(--leaf-bg)] px-2.5 py-1 text-[11px] font-bold text-primary">
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
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={() => setEditing(null)}>
          {t("common", K.cancel)}
        </button>
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void save()}>
          {t("common", K.capabilities.save)}
        </button>
      </div>
    </section>
  );
}

/** A variant's quotas in one line: `50 GB · 2 devices`. */
function QuotaSummary({ quotas }: { quotas: Quotas }) {
  const { t } = useLocale();
  const parts = Object.entries(quotas).map(([metric, q]) =>
    metric === "traffic_bytes"
      ? t("common", K.variant.gb, { count: quotaToInput("traffic_bytes", String(q!.limit)) })
      : `${t("common", K.metric[metric as keyof typeof K.metric])}: ${q!.limit}`,
  );
  return parts.length ? <>{` · ${parts.join(" · ")}`}</> : null;
}

function VariantCard({
  variant: v,
  kind,
  groups,
  money,
  onChanged,
}: {
  variant: CatalogVariant;
  kind: FulfilmentKind;
  groups: PanelGroups;
  money: (price: CatalogPrice) => string;
  onChanged: () => Promise<void>;
}) {
  const { t, lang } = useLocale();
  const message = useMessage();
  const { api } = useCatalogSurface();
  const [form, setForm] = useState<PriceForm>({ amount: "", day: "" });
  const [errors, setErrors] = useState<Errors<PriceForm>>({});
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const now = new Date();
  const current = currentPrice(v.prices, now);

  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
      await onChanged();
    } catch (e) {
      setError(message(e));
    }
  };

  const newPrice = async () => {
    const today = tehranToday();
    const found = validatePriceForm(form, today);
    setErrors(found);
    if (Object.keys(found).length) return;
    await act(() => api.setPrice(v.id, priceBody(form, today)));
    setForm({ amount: "", day: "" });
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-card-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold text-text-primary" dir="ltr">
            {v.sku}
          </p>
          <p className="text-[11px] text-text-secondary">
            {t("common", K.visibility[v.visibility])} · {t("common", K.billingMode[v.billingMode])} ·{" "}
            {v.durationDays === null ? t("common", K.variant.permanent) : t("common", K.variant.days, { count: v.durationDays })}
            <QuotaSummary quotas={v.quotas} />
            {!v.isActive && ` · ${t("common", K.inactive)}`}
          </p>
          {notForSale(v, kind) && <p className="mt-1 text-[11px] font-bold text-error">{t("common", K.variant.notForSale)}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-xs font-bold text-primary">
            {current ? money(current) : t("common", K.price.noPrice)}
          </span>
          <CopyId id={v.id} />
          <button type="button" className={quietButton} onClick={() => void act(() => api.updateVariant(v.id, { isActive: !v.isActive }))}>
            <Power size={14} aria-hidden />
            {t("common", v.isActive ? K.deactivate : K.activate)}
          </button>
        </div>
      </div>

      {takesPanelGroup(kind) && (
        <PanelGroupSelect value={v.panelGroupId ?? ""} groups={groups} onChange={(id) => void act(() => api.updateVariant(v.id, panelGroupPatch(id)))} />
      )}

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label={t("common", K.price.amount)} error={errors.amount}>
          <input className={input} dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
        </Field>
        <Field label={t("common", K.price.day)} error={errors.day} hint={t("common", K.price.dayHint)}>
          <DatePicker value={form.day || null} onChange={(d) => setForm((f) => ({ ...f, day: d ?? "" }))} />
        </Field>
        <button type="button" className={primaryButton} onClick={() => void newPrice()}>
          {t("common", K.newPrice)}
        </button>
      </div>

      <button type="button" className={`${quietButton} self-start`} aria-expanded={history} onClick={() => setHistory((h) => !h)}>
        <ChevronDown size={14} className={history ? "rotate-180" : ""} aria-hidden />
        {t("common", K.price.history)} ({v.prices.length})
      </button>
      {history && (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <tbody className="divide-y divide-card-border text-text-primary">
              {v.prices.map((p) => (
                <tr key={p.id}>
                  <td className="px-2 py-1.5">{money(p)}</td>
                  <td className="px-2 py-1.5">{t("common", K.price.effectiveFrom, { time: formatInstant(p.effectiveFrom, lang) ?? "" })}</td>
                  <td className="px-2 py-1.5">
                    {p.id === current?.id
                      ? t("common", K.price.current)
                      : !p.isActive
                        ? t("common", K.inactive)
                        : new Date(p.effectiveFrom) > now
                          ? t("common", K.price.scheduled)
                          : ""}
                  </td>
                  <td className="px-2 py-1.5 text-end">
                    {p.isActive && (
                      <button type="button" className={quietButton} onClick={() => void act(() => api.deactivatePrice(p.id))}>
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
      {error && <Alert>{error}</Alert>}
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
  const [advanced, setAdvanced] = useState(false);
  const setQuota = (i: number, patch: Partial<VariantForm["quotas"][number]>) =>
    set("quotas", form.quotas.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common", K.variant.durationDays)} error={errors.durationDays} hint={t("common", K.variant.durationHint)}>
          <input className={input} dir="ltr" inputMode="numeric" value={form.durationDays} onChange={(e) => set("durationDays", e.target.value)} />
        </Field>
        <Field label={t("common", K.variant.price)} error={errors.price}>
          <input className={input} dir="ltr" inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} />
        </Field>
        <Field label={t("common", K.variant.sku)} error={errors.sku} hint={t("common", K.variant.skuHint)}>
          <span className="flex gap-1">
            <input className={input} dir="ltr" value={form.sku} onChange={(e) => set("sku", e.target.value.toUpperCase())} />
            <button type="button" className={quietButton} onClick={() => set("sku", suggestSku(productKey, form.durationDays))}>
              <Sparkles size={14} aria-hidden />
              {t("common", K.wizard.suggestSku)}
            </button>
          </span>
        </Field>
      </div>

      {takesPanelGroup(kind) && <PanelGroupSelect value={form.panelGroupId} groups={groups} onChange={(id) => set("panelGroupId", id)} />}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-bold text-text-secondary">{t("common", K.variant.quotas)}</p>
        <p className="text-[11px] text-text-secondary">{t("common", K.variantHint.quotas)}</p>
        {form.quotas.map((q, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Select
              ariaLabel={t("common", K.variant.metric)}
              value={q.metric}
              onChange={(v) => setQuota(i, { metric: v as typeof q.metric, limit: "" })}
              options={QUOTA_METRICS.map((m) => ({ value: m, label: t("common", K.metric[m]) }))}
            />
            <input
              className={input}
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
            <button type="button" className={quietButton} onClick={() => set("quotas", form.quotas.filter((_, j) => j !== i))}>
              {t("common", K.variant.remove)}
            </button>
          </div>
        ))}
        {errors.quotas && <p className="text-[11px] text-error">{t("common", errors.quotas)}</p>}
        {form.quotas.length < QUOTA_METRICS.length && (
          <button
            type="button"
            className={`${quietButton} self-start`}
            onClick={() => {
              const free = QUOTA_METRICS.find((m) => !form.quotas.some((q) => q.metric === m)) ?? "traffic_bytes";
              set("quotas", [...form.quotas, { metric: free, limit: "", resetPolicy: "none" }]);
            }}
          >
            <Plus size={14} aria-hidden />
            {t("common", K.variant.addQuota)}
          </button>
        )}
      </div>

      <button type="button" className={`${quietButton} self-start`} aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
        <ChevronDown size={14} className={advanced ? "rotate-180" : ""} aria-hidden />
        {t("common", K.wizard.advanced)}
      </button>
      {advanced && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("common", K.variant.billingMode)} hint={t("common", K.variantHint.billingMode)}>
            <Select value={form.billingMode} onChange={(v) => set("billingMode", v as VariantForm["billingMode"])} options={BILLING_MODES.map((m) => ({ value: m, label: t("common", K.billingMode[m]) }))} />
          </Field>
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
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onCancel}>
          {t("common", K.cancel)}
        </button>
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void save()}>
          {t("common", K.save)}
        </button>
      </div>
    </section>
  );
}

/** The groups a variant may name on this surface, and whether they loaded. */
export interface PanelGroups {
  options: PanelGroupOption[];
  failed: boolean;
}

/** `GET /panel-groups` once, when the product is `network_access` (F-026-p); a failure costs the choices, never the form. */
export function usePanelGroups(enabled: boolean): PanelGroups {
  const { api } = useCatalogSurface();
  const [state, setState] = useState<PanelGroups>({ options: [], failed: false });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.panelGroups().then(
      (options) => live && setState({ options, failed: false }),
      () => live && setState({ options: [], failed: true }),
    );
    return () => {
      live = false;
    };
    // The surface's api is fixed for the page; `enabled` is what decides a load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return state;
}

/**
 * A variant's panel group (F-026-o): "none" first, because none is a real
 * answer — the variant is kept and simply not sold. Each group says whose it
 * is, how many panels fulfilment would place on now, and whether its strategy
 * is fulfilled at all. A group the list no longer has keeps its id as a label,
 * so the select never shows a variant as having none when it has one.
 */
function PanelGroupSelect({ value, groups, onChange }: { value: string; groups: PanelGroups; onChange: (id: string) => void }) {
  const { t } = useLocale();
  const label = (g: PanelGroupOption) =>
    [
      g.name,
      g.tenantId === null ? t("common", K.platform) : null,
      g.protocols.length > 0 ? g.protocols.join("/") : t("common", K.variant.noInbound),
      t("common", K.variant.healthy, { count: g.healthyMembers }),
      g.strategy === "mirror" ? null : t("common", K.variant.notFulfilled),
    ]
      .filter(Boolean)
      .join(" · ");
  const options = [{ value: "", label: t("common", K.variant.panelGroupNone) }, ...groups.options.map((g) => ({ value: g.id, label: label(g) }))];
  if (value && !groups.options.some((g) => g.id === value)) options.push({ value, label: value });
  return (
    <Field label={t("common", K.variant.panelGroup)} hint={t("common", groups.failed ? K.variant.panelGroupsFailed : K.variant.panelGroupHint)}>
      <Select ariaLabel={t("common", K.variant.panelGroup)} value={value} onChange={onChange} options={options} />
    </Field>
  );
}
