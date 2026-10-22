"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { type CatalogCapability, type CatalogCategory, type CatalogPrice, type CatalogProduct, type CatalogProductDetail, type FulfilmentKind } from "@/lib/catalog-api";
import { PricingCurrencyContext, useCatalogSurface, usePricingCurrency } from "../_lib/surface";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatMoney } from "../../_lib/money";
import {
  CATALOG_KEYS as K,
  capabilitiesFor,
  surfaceActor,
  emptyVariantForm,
  groupsForVariant,
  takesPanelGroup,
  suggestSku,
  validateVariantForm,
  variantBody,
  type Errors,
  type VariantForm,
} from "../_lib/catalog-form";
import { CapabilityPicker } from "./CapabilityPicker";
import { ProductCategories } from "./CategoryPickers";
import { ProductAudienceSection, ownsAudience } from "./ProductAudienceSection";
import { RenewalRateSection } from "./RenewalRateSection";
import { SelfMoveSettings } from "../../_components/SelfMoveSettings";
import { setsSelfMove } from "../../_lib/self-move-settings";
import { usePanelGroups, type PanelGroups } from "./PanelGroupSelect";
import { VariantFields } from "./VariantFields";
import { VariantCard } from "./VariantCard";
import { Sheet, useMessage } from "./catalog-ui";
import { Alert, Button } from "../../_components/kit";
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

  // F-410-f: a product whose services hold configs may override its tenant's self-move setting.
  const selfMoveTenant = surfaceTenantId ?? me?.tenant.id ?? null;

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
      {/* Who may buy it, and what GiB and days typed to renew it cost (F-305-g): the owner's alone. */}
      {detail && ownsAudience(detail, surfaceTenantId, me?.tenant.id ?? null) && (
        <>
          <ProductAudienceSection key={detail.id} product={detail} onSaved={onChanged} />
          <RenewalRateSection key={`renewal-${detail.id}`} productId={detail.id} />
        </>
      )}
      {detail && selfMoveTenant !== null && takesPanelGroup(kind) && setsSelfMove(detail, selfMoveTenant) && <SelfMoveSettings key={product.id} tenantId={selfMoveTenant} productId={product.id} errorMessage={message} />}

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

