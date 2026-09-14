"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2, Package, Plus, Power, RotateCw, Tags, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import {
  catalogApi,
  type CatalogCategory,
  type CatalogProduct,
  type CatalogProductDetail,
  type CatalogVariant,
} from "@/lib/catalog-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { DatePicker } from "../../_components/kit/DatePicker";
import { Select } from "../../_components/kit/Select";
import { BASE_CURRENCY, formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import {
  BILLING_MODES,
  CATALOG_KEYS as K,
  FULFILMENT_KINDS,
  QUALITY_TIERS,
  QUOTA_METRICS,
  RESET_POLICIES,
  VISIBILITIES,
  currentPrice,
  emptyProductForm,
  emptyVariantForm,
  isPlatformOwner,
  priceBody,
  productBody,
  refusalKey,
  tehranToday,
  validatePriceForm,
  validateProductForm,
  validateVariantForm,
  variantBody,
  type PriceForm,
  type ProductForm,
  type VariantForm,
} from "../_lib/catalog-form";

const input = "w-full rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-primary outline-none focus:border-primary";
const primaryButton = "inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white shadow-sm disabled:opacity-50";
const quietButton = "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-primary hover:bg-[var(--leaf-bg)]";

/** The refusal's own sentence, else the generic answer for that error. */
function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/**
 * The catalog page (F-026-f, D-34): categories, products, and for each product
 * its variants with their price history.
 *
 * One page for two audiences, and the page decides neither: billing answers
 * the platform owner every item and a tenant its own. Nothing is patched from a
 * write's answer — the list is re-read — and nothing is deleted: an item or a
 * price is switched off. A price change is always a new row (F-0602).
 */
export function CatalogView() {
  const { t } = useLocale();
  const message = useMessage();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const owner = isPlatformOwner(me);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [scope, setScope] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"product" | "category" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cats, prods] = await Promise.all([
        catalogApi.categories(),
        catalogApi.products({ categoryId: categoryId || undefined, tenantId: scope || undefined }),
      ]);
      setCategories(cats);
      setProducts(prods);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [categoryId, scope]);

  useEffect(() => {
    // Every setState in load runs after its first await, as in `CouponsView`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const toggle = async (p: CatalogProduct) => {
    setActionError(null);
    try {
      await catalogApi.updateProduct(p.id, { isActive: !p.isActive });
      setNotice(t("common", K.saved));
      await load();
    } catch (e) {
      setActionError(message(e));
    }
  };

  const categoryKey = (id: string) => categories.find((c) => c.id === id)?.key ?? "—";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <Package size={18} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h1>
          <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={quietButton} onClick={() => setCreating("category")}>
            <Tags size={14} aria-hidden />
            {t("common", K.newCategory)}
          </button>
          <button type="button" className={primaryButton} onClick={() => setCreating("product")}>
            <Plus size={14} aria-hidden />
            {t("common", K.newProduct)}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <Select
          ariaLabel={t("common", K.filters.category)}
          value={categoryId}
          onChange={setCategoryId}
          options={[{ value: "", label: t("common", K.filters.allCategories) }, ...categories.map((c) => ({ value: c.id, label: c.key }))]}
          className="w-44"
        />
        {owner && (
          <Select
            ariaLabel={t("common", K.filters.scope)}
            value={scope}
            onChange={setScope}
            options={[
              { value: "", label: t("common", K.filters.scopeAll) },
              { value: "platform", label: t("common", K.filters.scopePlatform) },
            ]}
            className="w-40"
          />
        )}
      </div>

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
      {actionError && (
        <p role="alert" className="text-xs font-bold text-error">
          {actionError}
        </p>
      )}

      {sessionLoading || (!products && !error) ? (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.loading)}
        </p>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-xs font-bold text-error">
            {message(error)}
          </p>
          <button type="button" className={quietButton} onClick={() => void load()}>
            <RotateCw size={14} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : products!.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {products!.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-text-primary" dir="ltr">
                  {p.key}
                </p>
                <p className="text-[11px] text-text-secondary">
                  {categoryKey(p.categoryId)} · {t("common", K.fulfilmentKind[p.fulfilmentKind])}
                  {p.tenantId === null && ` · ${t("common", K.platform)}`}
                  {!p.isActive && ` · ${t("common", K.inactive)}`}
                </p>
              </div>
              <div className="flex gap-1">
                <button type="button" className={quietButton} onClick={() => setOpenId(p.id)}>
                  {t("common", K.open)}
                </button>
                <button type="button" className={quietButton} onClick={() => void toggle(p)}>
                  <Power size={14} aria-hidden />
                  {t("common", p.isActive ? K.deactivate : K.activate)}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating === "category" && (
        <CategorySheet
          owner={owner}
          onClose={() => setCreating(null)}
          onSaved={async () => {
            setCreating(null);
            setNotice(t("common", K.saved));
            await load();
          }}
        />
      )}
      {creating === "product" && (
        <ProductSheet
          categories={categories}
          onClose={() => setCreating(null)}
          onSaved={async () => {
            setCreating(null);
            setNotice(t("common", K.saved));
            await load();
          }}
        />
      )}
      {openId && <VariantsSheet productId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useLocale();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-t-3xl border border-card-border bg-card-bg shadow-xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b border-card-border p-4">
          <h2 className="text-sm font-bold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t("common", K.close)} className="rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="flex flex-col gap-4 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  const { t } = useLocale();
  return (
    <label className="flex flex-col gap-1 text-xs font-bold text-text-secondary">
      {label}
      {children}
      {hint && !error && <span className="text-[11px] font-normal">{hint}</span>}
      {error && <span className="text-[11px] text-error">{t("common", error)}</span>}
    </label>
  );
}

function CategorySheet({ owner, onClose, onSaved }: { owner: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useMessage();
  const [key, setKey] = useState("");
  const [nameKey, setNameKey] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await catalogApi.createCategory({ key: key.trim(), nameKey: nameKey.trim(), ...(owner && shared ? { tenantId: null } : {}) });
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t("common", K.newCategory)} onClose={onClose}>
      <Field label={t("common", K.category.key)}>
        <input className={input} dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <Field label={t("common", K.category.nameKey)} hint={t("common", K.product.nameHint)}>
        <input className={input} dir="ltr" value={nameKey} onChange={(e) => setNameKey(e.target.value)} />
      </Field>
      {owner && (
        <label className="flex items-center gap-2 text-xs text-text-primary">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          {t("common", K.category.shared)}
        </label>
      )}
      {error && (
        <p role="alert" className="text-xs font-bold text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onClose}>
          {t("common", K.cancel)}
        </button>
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void save()}>
          {t("common", K.save)}
        </button>
      </div>
    </Sheet>
  );
}

function ProductSheet({ categories, onClose, onSaved }: { categories: CatalogCategory[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useMessage();
  const { me } = usePanelSession();
  const owner = isPlatformOwner(me);
  const [form, setForm] = useState<ProductForm>(emptyProductForm);
  const [errors, setErrors] = useState<Partial<Record<keyof ProductForm, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <F extends keyof ProductForm>(k: F, v: ProductForm[F]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const found = validateProductForm(form, me);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    try {
      await catalogApi.createProduct(productBody(form, me));
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t("common", K.newProduct)} onClose={onClose}>
      {owner && (
        <Field label={t("common", K.product.owner)}>
          <Select
            value={form.owner}
            onChange={(v) => set("owner", v as ProductForm["owner"])}
            options={[
              { value: "own", label: t("common", K.product.ownerOwn) },
              { value: "platform", label: t("common", K.product.ownerPlatform) },
              { value: "tenant", label: t("common", K.product.ownerTenant) },
            ]}
          />
        </Field>
      )}
      {owner && form.owner === "tenant" && (
        <Field label={t("common", K.product.tenantId)} error={errors.tenantId}>
          <input className={input} dir="ltr" value={form.tenantId} onChange={(e) => set("tenantId", e.target.value)} />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common", K.product.category)} error={errors.categoryId}>
          <Select value={form.categoryId} onChange={(v) => set("categoryId", v)} options={categories.map((c) => ({ value: c.id, label: c.key }))} placeholder="—" />
        </Field>
        <Field label={t("common", K.product.fulfilmentKind)}>
          <Select
            value={form.fulfilmentKind}
            onChange={(v) => set("fulfilmentKind", v as ProductForm["fulfilmentKind"])}
            options={FULFILMENT_KINDS.map((k) => ({ value: k, label: t("common", K.fulfilmentKind[k]) }))}
          />
        </Field>
        <Field label={t("common", K.product.key)} error={errors.key}>
          <input className={input} dir="ltr" value={form.key} onChange={(e) => set("key", e.target.value)} />
        </Field>
        <Field label={t("common", K.product.nameKey)} error={errors.nameKey} hint={t("common", K.product.nameHint)}>
          <input className={input} dir="ltr" value={form.nameKey} onChange={(e) => set("nameKey", e.target.value)} />
        </Field>
        <Field label={t("common", K.product.descriptionKey)} error={errors.descriptionKey}>
          <input className={input} dir="ltr" value={form.descriptionKey} onChange={(e) => set("descriptionKey", e.target.value)} />
        </Field>
        <Field label={t("common", K.product.featureKeys)} error={errors.featureKeys} hint={t("common", K.product.featureKeysHint)}>
          <textarea className={input} dir="ltr" rows={2} value={form.featureKeys} onChange={(e) => set("featureKeys", e.target.value)} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-xs font-bold text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onClose}>
          {t("common", K.cancel)}
        </button>
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void save()}>
          {t("common", K.save)}
        </button>
      </div>
    </Sheet>
  );
}

function VariantsSheet({ productId, onClose }: { productId: string; onClose: () => void }) {
  const { t, lang } = useLocale();
  const message = useMessage();
  const [detail, setDetail] = useState<CatalogProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await catalogApi.product(productId));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
    // `message` is rebuilt each render; the product is what decides a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const money = (amount: string) => formatMoney(amount, BASE_CURRENCY, { lang, t });

  return (
    <Sheet title={detail ? `${detail.key} · ${t("common", K.open)}` : t("common", K.open)} onClose={onClose}>
      {error && (
        <p role="alert" className="text-xs font-bold text-error">
          {error}
        </p>
      )}
      {!detail && !error && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.loading)}
        </p>
      )}
      {detail?.variants.map((v) => (
        <VariantCard key={v.id} variant={v} money={money} onChanged={load} />
      ))}
      {detail &&
        (adding ? (
          <NewVariant
            productId={productId}
            onCancel={() => setAdding(false)}
            onSaved={async () => {
              setAdding(false);
              await load();
            }}
          />
        ) : (
          <button type="button" className={primaryButton} onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden />
            {t("common", K.newVariant)}
          </button>
        ))}
    </Sheet>
  );
}

function VariantCard({ variant: v, money, onChanged }: { variant: CatalogVariant; money: (a: string) => string; onChanged: () => Promise<void> }) {
  const { t, lang } = useLocale();
  const message = useMessage();
  const [form, setForm] = useState<PriceForm>({ amount: "", day: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof PriceForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
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
    await act(() => catalogApi.setPrice(v.id, priceBody(form, today)));
    setForm({ amount: "", day: "" });
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-card-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono text-sm font-bold text-text-primary" dir="ltr">
            {v.sku}
          </p>
          <p className="text-[11px] text-text-secondary">
            {t("common", K.visibility[v.visibility])} · {t("common", K.billingMode[v.billingMode])} ·{" "}
            {v.durationDays === null ? t("common", K.variant.permanent) : t("common", K.variant.days, { count: v.durationDays })}
            {!v.isActive && ` · ${t("common", K.inactive)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-xs font-bold text-primary">
            {current ? money(current.amount) : t("common", K.price.noPrice)}
          </span>
          <button type="button" className={quietButton} onClick={() => void act(() => catalogApi.updateVariant(v.id, { isActive: !v.isActive }))}>
            <Power size={14} aria-hidden />
            {t("common", v.isActive ? K.deactivate : K.activate)}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-start text-xs">
          <caption className="pb-1 text-start text-[11px] font-bold text-text-secondary">{t("common", K.price.history)}</caption>
          <tbody className="divide-y divide-card-border text-text-primary">
            {v.prices.map((p) => (
              <tr key={p.id}>
                <td className="px-2 py-1.5">{money(p.amount)}</td>
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
                    <button type="button" className={quietButton} onClick={() => void act(() => catalogApi.deactivatePrice(p.id))}>
                      {t("common", K.deactivate)}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
      {error && (
        <p role="alert" className="text-xs font-bold text-error">
          {error}
        </p>
      )}
    </section>
  );
}

function NewVariant({ productId, onCancel, onSaved }: { productId: string; onCancel: () => void; onSaved: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useMessage();
  const [form, setForm] = useState<VariantForm>(emptyVariantForm);
  const [errors, setErrors] = useState<Partial<Record<keyof VariantForm, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <F extends keyof VariantForm>(k: F, v: VariantForm[F]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const found = validateVariantForm(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    try {
      await catalogApi.createVariant(productId, variantBody(form));
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const setQuota = (i: number, patch: Partial<VariantForm["quotas"][number]>) =>
    set("quotas", form.quotas.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-dashed border-primary p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common", K.variant.sku)} error={errors.sku} hint={t("common", K.variant.skuHint)}>
          <input className={input} dir="ltr" value={form.sku} onChange={(e) => set("sku", e.target.value)} />
        </Field>
        <Field label={t("common", K.variant.price)} error={errors.price}>
          <input className={input} dir="ltr" inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} />
        </Field>
        <Field label={t("common", K.variant.billingMode)}>
          <Select value={form.billingMode} onChange={(v) => set("billingMode", v as VariantForm["billingMode"])} options={BILLING_MODES.map((m) => ({ value: m, label: t("common", K.billingMode[m]) }))} />
        </Field>
        <Field label={t("common", K.variant.visibility)}>
          <Select value={form.visibility} onChange={(v) => set("visibility", v as VariantForm["visibility"])} options={VISIBILITIES.map((m) => ({ value: m, label: t("common", K.visibility[m]) }))} />
        </Field>
        <Field label={t("common", K.variant.qualityTier)}>
          <Select value={form.qualityTier} onChange={(v) => set("qualityTier", v as VariantForm["qualityTier"])} options={QUALITY_TIERS.map((m) => ({ value: m, label: t("common", K.qualityTier[m]) }))} />
        </Field>
        <Field label={t("common", K.variant.durationDays)} error={errors.durationDays} hint={t("common", K.variant.durationHint)}>
          <input className={input} dir="ltr" inputMode="numeric" value={form.durationDays} onChange={(e) => set("durationDays", e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-bold text-text-secondary">{t("common", K.variant.quotas)}</p>
        {form.quotas.map((q, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Select ariaLabel={t("common", K.variant.metric)} value={q.metric} onChange={(v) => setQuota(i, { metric: v as typeof q.metric })} options={QUOTA_METRICS.map((m) => ({ value: m, label: t("common", K.metric[m]) }))} />
            <input className={input} dir="ltr" inputMode="numeric" aria-label={t("common", K.variant.limit)} value={q.limit} onChange={(e) => setQuota(i, { limit: e.target.value })} />
            <Select ariaLabel={t("common", K.variant.resetPolicy)} value={q.resetPolicy} onChange={(v) => setQuota(i, { resetPolicy: v as typeof q.resetPolicy })} options={RESET_POLICIES.map((m) => ({ value: m, label: t("common", K.resetPolicy[m]) }))} />
            <button type="button" className={quietButton} onClick={() => set("quotas", form.quotas.filter((_, j) => j !== i))}>
              {t("common", K.variant.remove)}
            </button>
          </div>
        ))}
        {errors.quotas && <p className="text-[11px] text-error">{t("common", errors.quotas)}</p>}
        <button
          type="button"
          className={`${quietButton} self-start`}
          onClick={() => set("quotas", [...form.quotas, { metric: "traffic_bytes", limit: "", resetPolicy: "none" }])}
        >
          <Plus size={14} aria-hidden />
          {t("common", K.variant.addQuota)}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs font-bold text-error">
          {error}
        </p>
      )}
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
