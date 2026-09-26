"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { type CatalogCapability, type CatalogCategory } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { DEFAULT_LOCALE } from "@/env";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Select } from "../../_components/kit/Select";
import {
  CATALOG_KEYS as K,
  DESCRIPTION_MAX,
  CREATABLE_FULFILMENT_KINDS,
  NAME_MAX,
  WIZARD_STEPS,
  capabilitiesFor,
  wizardCategoryBody,
  isPlatformOwner,
  productBody,
  suggestKey,
  surfaceActor,
  suggestSku,
  variantBody,
  takesPanelGroup,
  groupsForVariant,
  wizardVariantTenant,
  wizardStepErrors,
  emptyWizard,
  firstInvalidStep,
  type ProductForm,
  type ProductWizard as Wizard,
  type VariantForm,
  type WizardStep,
} from "../_lib/catalog-form";
import { CapabilityPicker } from "./CapabilityPicker";
import { CategoryFields } from "./NameSheets";
import { CategoryMultiPicker, TranslateAllBox } from "./CategoryPickers";
import { VariantFields, usePanelGroups } from "./ProductDetailSheet";
import { Alert, Field, KeyField, LanguageSelect, Sheet, input, primaryButton, quietButton, useDirOf, useMessage } from "./catalog-ui";

/** Which step a refusal belongs to, so the wizard returns the admin to the field billing named. */
const REFUSAL_STEP: Record<string, WizardStep> = {
  key_taken: "names",
  source_text_missing: "names",
  lang_unknown: "names",
  category_not_found: "category",
  category_cycle: "category",
  category_too_deep: "category",
  tenant_not_found: "access",
  not_platform_owner: "access",
  capability_unknown: "access",
  sku_taken: "variant",
  traffic_quota_required: "variant",
};

/**
 * A new product, one question per step (category → name → type and
 * capabilities → first variant and price → review), each step checked before
 * the next. Keys and the SKU are made for the admin; capabilities are picked.
 *
 * The saves are three calls — a new category, the product, its first variant —
 * and each id is kept once made, so "create" after a refusal repeats only
 * what did not happen yet.
 */
export function ProductWizard({
  categories,
  categoryLabel,
  takenProductKeys,
  takenCategoryKeys,
  capabilities,
  capabilityLabel,
  onCapabilityCreated,
  onClose,
  onCreated,
}: {
  categories: CatalogCategory[];
  categoryLabel: (c: CatalogCategory) => string;
  takenProductKeys: readonly string[];
  takenCategoryKeys: readonly string[];
  /** Every capability the caller sees; the product is offered those its tenant may carry. */
  capabilities: readonly CatalogCapability[];
  capabilityLabel: (c: CatalogCapability) => string;
  /** Re-reads the list after "new capability". */
  onCapabilityCreated: () => Promise<void>;
  onClose: () => void;
  onCreated: (productId: string, variantFailed: boolean) => Promise<void>;
}) {
  const { t } = useLocale();
  const message = useMessage();
  const { api, tenantId } = useCatalogSurface();
  const dirOf = useDirOf();
  const { me } = usePanelSession();
  // On a reseller's screen nobody is an owner: billing runs the work as the
  // reseller, and its schema refuses the `tenantId` an owner's form would send.
  const actor = surfaceActor(me, tenantId);
  const owner = isPlatformOwner(actor);
  const [w, setW] = useState<Wizard>(() => ({
    ...emptyWizard(DEFAULT_LOCALE),
    categoryMode: categories.length ? "existing" : "new",
    categoryIds: categories.length === 1 ? [categories[0].id] : [],
  }));
  const [step, setStep] = useState<WizardStep>("category");
  const [reached, setReached] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [keyTouched, setKeyTouched] = useState(false);
  const [skuTouched, setSkuTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ categoryId?: string; productId?: string }>({});
  const kind = w.product.fulfilmentKind;
  const groups = usePanelGroups(takesPanelGroup(kind));
  const productTenant = wizardVariantTenant(w.product, actor);
  const offered = { ...groups, options: groupsForVariant(groups.options, productTenant) };
  const capabilityName = (k: string) => {
    const c = capabilities.find((x) => x.key === k);
    return c ? capabilityLabel(c) : k;
  };

  const index = WIZARD_STEPS.indexOf(step);
  const go = (to: WizardStep) => {
    setErrors({});
    setError(null);
    setStep(to);
    setReached((r) => Math.max(r, WIZARD_STEPS.indexOf(to)));
  };
  const next = () => {
    const found = wizardStepErrors(step, w, actor, categories);
    setErrors(found);
    if (Object.keys(found).length) return;
    // The SKU follows the product key and the duration until the admin types one.
    if (step === "names" && !skuTouched) setVariant({ sku: suggestSku(w.product.key, w.variant.durationDays) });
    go(WIZARD_STEPS[index + 1]);
  };

  const setProduct = (patch: Partial<ProductForm>) => setW((x) => ({ ...x, product: { ...x.product, ...patch } }));
  const setVariant = (patch: Partial<VariantForm>) => setW((x) => ({ ...x, variant: { ...x.variant, ...patch } }));

  const create = async () => {
    const invalid = firstInvalidStep(w, actor, categories);
    if (invalid) {
      go(invalid);
      setErrors(wizardStepErrors(invalid, w, actor, categories));
      return;
    }
    setBusy(true);
    setError(null);
    let stage: WizardStep = "category";
    let ids = created;
    try {
      if (w.categoryMode === "new" && !ids.categoryId) {
        const c = await api.createCategory(wizardCategoryBody(w, actor));
        ids = { ...ids, categoryId: c.id };
        setCreated(ids);
      }
      stage = "names";
      if (!ids.productId) {
        const categoryIds = w.categoryMode === "new" ? [ids.categoryId!] : w.categoryIds;
        const p = await api.createProduct(productBody({ ...w.product, categoryIds }, actor));
        ids = { ...ids, productId: p.id };
        setCreated(ids);
      }
      stage = "variant";
      if (w.withVariant) await api.createVariant(ids.productId!, variantBody(w.variant, kind));
      await onCreated(ids.productId!, false);
    } catch (e) {
      const reason = (e as { reason?: unknown } | null)?.reason;
      const to = (typeof reason === "string" && REFUSAL_STEP[reason]) || stage;
      if (stage === "variant" && to === "variant" && reason !== "sku_taken") {
        // The product exists; only the variant failed. Close into the product, where it can be added.
        await onCreated(ids.productId!, true);
        return;
      }
      setStep(to === "names" && stage === "category" ? "category" : to);
      if (reason === "key_taken") setErrors({ key: K.refusals.key_taken });
      if (reason === "sku_taken") setErrors({ sku: K.refusals.sku_taken });
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const nameDir = dirOf(w.product.sourceLang);
  const picked = w.categoryIds.map((id) => categories.find((c) => c.id === id)).filter((c): c is CatalogCategory => c !== undefined);

  const footer = (
    <div className="flex items-center justify-between gap-2">
      <button type="button" className={quietButton} disabled={index === 0 || busy} onClick={() => go(WIZARD_STEPS[index - 1])}>
        <ChevronRight size={14} className="ltr:-scale-x-100" aria-hidden />
        {t("common", K.wizard.back)}
      </button>
      <span className="text-[11px] text-text-secondary">{t("common", K.wizard.stepOf, { current: index + 1, total: WIZARD_STEPS.length })}</span>
      {step === "review" ? (
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void create()}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
          {t("common", K.wizard.create)}
        </button>
      ) : (
        <button type="button" className={primaryButton} onClick={next}>
          {t("common", K.wizard.next)}
          <ChevronLeft size={14} className="ltr:-scale-x-100" aria-hidden />
        </button>
      )}
    </div>
  );

  return (
    <Sheet title={t("common", K.wizard.title)} onClose={onClose} footer={footer}>
      <ol className="flex flex-wrap gap-1.5">
        {WIZARD_STEPS.map((s, i) => {
          const state = s === step ? "now" : i <= reached ? "seen" : "later";
          return (
            <li key={s}>
              <button
                type="button"
                disabled={state === "later" || busy}
                aria-current={state === "now" ? "step" : undefined}
                onClick={() => go(s)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                  state === "now" ? "bg-primary text-white" : state === "seen" ? "bg-[var(--leaf-bg)] text-primary" : "bg-bg-inner text-text-secondary"
                }`}
              >
                <span className="inline-flex size-4 items-center justify-center rounded-full bg-white/25 text-[10px]">{i + 1}</span>
                {t("common", K.wizard.steps[s])}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="text-sm font-bold text-text-primary">{t("common", K.wizard.intro[step])}</p>

      {step === "category" && (
        <div className="flex flex-col gap-3">
          {w.categoryMode === "existing" ? (
            <>
              <p className="text-[11px] text-text-secondary">{t("common", K.product.categoriesHint)}</p>
              <CategoryMultiPicker categories={categories} label={categoryLabel} value={w.categoryIds} onChange={(ids) => setW((x) => ({ ...x, categoryIds: ids }))} />
              {errors.categoryIds && (
                <p className="text-[11px] text-error">
                  {t("common", errors.categoryIds === K.wizard.categoryNotForOwner ? K.wizard.categoryNotForOwner : K.wizard.pickCategory)}
                </p>
              )}
              <button type="button" className={`${quietButton} self-start`} onClick={() => setW((x) => ({ ...x, categoryMode: "new" }))}>
                {t("common", K.wizard.useNewCategory)}
              </button>
            </>
          ) : (
            <>
              {categories.length === 0 && <p className="text-[11px] text-text-secondary">{t("common", K.wizard.noCategories)}</p>}
              <CategoryFields
                form={w.newCategory}
                onChange={(c) => setW((x) => ({ ...x, newCategory: c }))}
                errors={errors}
                takenKeys={takenCategoryKeys}
                owner={owner}
                categories={categories}
                label={categoryLabel}
              />
              {categories.length > 0 && (
                <button type="button" className={`${quietButton} self-start`} onClick={() => setW((x) => ({ ...x, categoryMode: "existing" }))}>
                  {t("common", K.wizard.useExistingCategory)}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {step === "names" && (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label={t("common", K.product.sourceLang)} error={errors.sourceLang}>
              <LanguageSelect value={w.product.sourceLang} onChange={(v) => setProduct({ sourceLang: v })} />
            </Field>
            <Field label={t("common", K.product.name)} error={errors.name} hint={t("common", K.product.nameHint)}>
              <input
                className={input}
                dir={nameDir}
                maxLength={NAME_MAX}
                autoFocus
                value={w.product.name}
                onChange={(e) =>
                  setProduct({ name: e.target.value, ...(keyTouched ? {} : { key: suggestKey(e.target.value, takenProductKeys, "product") }) })
                }
              />
            </Field>
          </div>
          <Field label={t("common", K.product.description)}>
            <textarea className={input} dir={nameDir} rows={3} maxLength={DESCRIPTION_MAX} value={w.product.description} onChange={(e) => setProduct({ description: e.target.value })} />
          </Field>
          <TranslateAllBox checked={w.product.translateAll} onChange={(v) => setProduct({ translateAll: v })} />
          <KeyField
            value={w.product.key}
            error={errors.key}
            onChange={(v) => {
              setKeyTouched(true);
              setProduct({ key: v });
            }}
          />
        </div>
      )}

      {step === "access" && (
        <div className="flex flex-col gap-4">
          {owner && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("common", K.product.owner)}>
                <Select
                  value={w.product.owner}
                  onChange={(v) => setProduct({ owner: v as ProductForm["owner"] })}
                  options={[
                    { value: "own", label: t("common", K.product.ownerOwn) },
                    { value: "platform", label: t("common", K.product.ownerPlatform) },
                    { value: "tenant", label: t("common", K.product.ownerTenant) },
                  ]}
                />
              </Field>
              {w.product.owner === "tenant" && (
                <Field label={t("common", K.product.tenantId)} error={errors.tenantId}>
                  <input className={input} dir="ltr" value={w.product.tenantId} onChange={(e) => setProduct({ tenantId: e.target.value })} />
                </Field>
              )}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-bold text-text-secondary">{t("common", K.product.fulfilmentKind)}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {CREATABLE_FULFILMENT_KINDS.map((kind) => (
                <Choice key={kind} on={w.product.fulfilmentKind === kind} onClick={() => setProduct({ fulfilmentKind: kind })}>
                  <span className="text-sm font-bold">{t("common", K.fulfilmentKind[kind])}</span>
                  <span className="text-[11px] font-normal leading-5 text-text-secondary">{t("common", K.fulfilmentHint[kind])}</span>
                </Choice>
              ))}
            </div>
          </div>
          <CapabilityPicker
            value={w.product.featureKeys}
            onChange={(keys) => setProduct({ featureKeys: keys })}
            options={capabilitiesFor(capabilities, productTenant)}
            label={capabilityLabel}
            takenKeys={capabilities.map((c) => c.key)}
            newTenant={productTenant}
            onCreated={onCapabilityCreated}
            error={errors.featureKeys}
          />
        </div>
      )}

      {step === "variant" && (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-xs font-bold text-text-primary">
            <input type="checkbox" checked={w.withVariant} onChange={(e) => setW((x) => ({ ...x, withVariant: e.target.checked }))} />
            {t("common", K.wizard.withVariant)}
          </label>
          {w.withVariant ? (
            <VariantFields
              form={w.variant}
              errors={errors}
              productKey={w.product.key}
              kind={kind}
              groups={offered}
              set={(k, v) => {
                if (k === "sku") setSkuTouched(true);
                const patch: Partial<VariantForm> = { [k]: v };
                if (k === "durationDays" && !skuTouched) patch.sku = suggestSku(w.product.key, v as string);
                setVariant(patch);
              }}
            />
          ) : (
            <p className="rounded-xl bg-[var(--leaf-bg)] p-3 text-xs text-text-primary">{t("common", K.wizard.skipVariant)}</p>
          )}
        </div>
      )}

      {step === "review" && (
        <dl className="grid gap-x-4 gap-y-2 rounded-2xl border border-card-border p-3 text-xs sm:grid-cols-[10rem_1fr]">
          <Row label={t("common", K.wizard.steps.category)} onEdit={() => go("category")}>
            {w.categoryMode === "new" ? w.newCategory.name : picked.length ? picked.map(categoryLabel).join("، ") : t("common", K.wizard.none)}
          </Row>
          <Row label={t("common", K.product.name)} onEdit={() => go("names")}>
            <span dir={nameDir}>{w.product.name}</span>{" "}
            <span dir="ltr" className="font-mono text-[11px] text-text-secondary">
              ({w.product.key})
            </span>
          </Row>
          <Row label={t("common", K.product.fulfilmentKind)} onEdit={() => go("access")}>
            {t("common", K.fulfilmentKind[w.product.fulfilmentKind])}
          </Row>
          <Row label={t("common", K.capabilities.label)} onEdit={() => go("access")}>
            {w.product.featureKeys.map(capabilityName).join("، ") || t("common", K.wizard.none)}
          </Row>
          <Row label={t("common", K.wizard.steps.variant)} onEdit={() => go("variant")}>
            {w.withVariant ? (
              <>
                <span dir="ltr" className="font-mono">
                  {w.variant.sku}
                </span>
                {" · "}
                {w.variant.durationDays ? t("common", K.variant.days, { count: Number(w.variant.durationDays) }) : t("common", K.variant.permanent)}
                {" · "}
                <span dir="ltr">{w.variant.price} USD</span>
                {takesPanelGroup(kind) && (
                  <>
                    {" · "}
                    {offered.options.find((g) => g.id === w.variant.panelGroupId)?.name ?? t("common", K.variant.notForSale)}
                  </>
                )}
              </>
            ) : (
              t("common", K.wizard.skipVariant)
            )}
          </Row>
        </dl>
      )}

      {error && <Alert>{error}</Alert>}
    </Sheet>
  );
}

function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 rounded-xl border p-3 text-start text-text-primary ${
        on ? "border-primary bg-[var(--leaf-bg)] ring-1 ring-primary" : "border-card-border bg-bg-inner hover:border-primary"
      }`}
    >
      {children}
    </button>
  );
}

function Row({ label, onEdit, children }: { label: string; onEdit: () => void; children: ReactNode }) {
  const { t } = useLocale();
  return (
    <>
      <dt className="font-bold text-text-secondary">{label}</dt>
      <dd className="flex flex-wrap items-center justify-between gap-2 text-text-primary">
        <span>{children}</span>
        <button type="button" className={quietButton} onClick={onEdit}>
          {t("common", K.wizard.edit)}
        </button>
      </dd>
    </>
  );
}
