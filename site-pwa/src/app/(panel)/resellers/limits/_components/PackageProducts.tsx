"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { usePackageTexts } from "../../../_hooks/usePackageTexts";
import { catalogApi, type CatalogProduct } from "@/lib/catalog-api";
import { resellerLimitsApi, type PackageProduct, type TenantPackage } from "@/lib/tenant-api";
import { flattenTexts } from "../../../catalog/_lib/catalog-form";
import { Alert, useMessage } from "../../_components/resellers-ui";
import { LIMIT_KEYS as K, productQuotaBodyOf, productQuotaFormOf, type ProductQuotaForm } from "../../_lib/limits";
import { ModeRadios, useOverageHeld } from "./QuotaOverage";
import { Button, useConfirm } from "../../../_components/kit";
import { useOneWrite } from "../../_hooks/useOneWrite";

const P = K.products;
const WINDOWS = ["day", "week", "month"] as const;
const box = "w-24 rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-primary outline-none focus:border-primary";

/**
 * What one package lets its resellers sell of the platform's products, and
 * each product's sales quota (F-019-v9; tenant `contract.limits.md`, F-019-v5,
 * F-019-v6): included per fixed day / week / month — blank is no bound — and
 * one answer past them. The limits page picks the package here; a package's
 * own page shows {@link ProductTermsList} in its products sheet (PK-1-f).
 */
export function PackageProducts({ packages }: { packages: TenantPackage[] }) {
  const { t } = useLocale();
  const packageTexts = usePackageTexts();
  const [packageId, setPackageId] = useState("");

  return (
    <section aria-label={t("common", P.title)} className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <h2 className="text-base font-bold text-text-primary">{t("common", P.title)}</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", P.hint)}</p>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs font-bold text-text-primary">
        {t("common", P.package)}
        <select value={packageId} onChange={(e) => setPackageId(e.target.value)} className={`${box} w-56`}>
          <option value="">{t("common", P.pick)}</option>
          {packages.map((p) => (
            <option key={p.id} value={p.id}>
              {packageTexts.name(p)}
            </option>
          ))}
        </select>
      </label>
      {packageId && <ProductTermsList key={packageId} packageId={packageId} />}
    </section>
  );
}

/**
 * Every platform product, sold by package `packageId` or not, each with its
 * terms there; a reseller's own products are not the platform's to list.
 * `onSaved` hears every list and unlist, after the list is read again.
 */
export function ProductTermsList({ packageId, onSaved }: { packageId: string; onSaved?: () => void }) {
  const { lang } = useLocale();
  const message = useMessage();
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [listed, setListed] = useState<PackageProduct[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => {
    setAsked((n) => n + 1);
    onSaved?.();
  }, [onSaved]);

  useEffect(() => {
    let alive = true;
    catalogApi.products().then(
      (list) => alive && setProducts(list.filter((p) => p.platform)),
      (e) => alive && setError(e),
    );
    catalogApi
      .texts(lang)
      .then(flattenTexts)
      .catch(() => ({}))
      .then((flat) => alive && setTexts(flat));
    return () => {
      alive = false;
    };
  }, [lang]);

  useEffect(() => {
    let alive = true;
    resellerLimitsApi.packageProducts(packageId).then(
      (rows) => {
        if (!alive) return;
        setListed(rows);
        setError(null);
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [packageId, asked]);

  const byId = new Map((listed ?? []).map((l) => [l.productId, l]));

  if (error !== null) return <Alert>{message(error)}</Alert>;
  if (listed === null || products === null) return null;
  return (
    <div className="space-y-3">
      {products.map((p) => {
        const row = byId.get(p.id) ?? null;
        return (
          <ProductTerms
            key={`${p.id}:${JSON.stringify(row?.quota ?? null)}`}
            packageId={packageId}
            productId={p.id}
            name={texts[p.nameKey] || p.key}
            isActive={p.isActive}
            row={row}
            onSaved={reload}
          />
        );
      })}
    </div>
  );
}

function ProductTerms({
  packageId,
  productId,
  name,
  isActive,
  row,
  onSaved,
}: {
  packageId: string;
  productId: string;
  name: string;
  isActive: boolean;
  row: PackageProduct | null;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const held = useOverageHeld();
  const radios = useId();
  const [form, setForm] = useState<ProductQuotaForm>(() => productQuotaFormOf(row?.quota ?? null));
  const { busy, failure, run } = useOneWrite(onSaved);
  const body = productQuotaBodyOf(form);
  const set = (patch: Partial<ProductQuotaForm>) => setForm((f) => ({ ...f, ...patch }));

  const windowText = (v: number | null) => (v === null ? t("common", K.noLimit) : String(v));

  return (
    <div role="group" aria-label={name} className="space-y-2 border-t border-card-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-text-primary">{name}</span>
        {!isActive && <span className="text-2xs text-text-secondary">{t("common", P.inactive)}</span>}
      </div>
      <p className="text-xs text-text-secondary">
        {row
          ? t("common", P.listed, {
              day: windowText(row.quota.day),
              week: windowText(row.quota.week),
              month: windowText(row.quota.month),
              past: held(row.quota.overage),
            })
          : t("common", P.notListed)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {WINDOWS.map((w) => (
          <label key={w} className="flex items-center gap-1 text-xs text-text-secondary">
            {t("common", P.windows[w])}
            <input
              type="text"
              inputMode="numeric"
              dir="ltr"
              aria-label={t("common", P.windows[w])}
              placeholder={t("common", K.noLimit)}
              value={form[w]}
              onChange={(e) => set({ [w]: e.target.value })}
              className={box}
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ModeRadios name={radios} mode={form.mode} onChange={(mode) => set({ mode })} />
        <input
          type="text"
          inputMode="decimal"
          dir="ltr"
          aria-label={t("common", K.overage.priceFor, { name })}
          value={form.price}
          disabled={form.mode === "stop"}
          onChange={(e) => set({ price: e.target.value })}
          className={box}
        />
        <Button variant="primary" size="sm" disabled={busy || body === undefined} onClick={() => body && run(() => resellerLimitsApi.setPackageProduct(packageId, productId, body))}>
          {t("common", row ? K.save : P.list)}
        </Button>
        {row && (
          <Button
            variant="quiet"
            size="sm"
            disabled={busy}
            onClick={async () => (await confirm({ title: t("common", P.unlistConfirm, { name }), confirmLabel: t("common", P.unlist), tone: "danger", typeToConfirm: name })) && run(() => resellerLimitsApi.clearPackageProduct(packageId, productId))}
          >
            {t("common", P.unlist)}
          </Button>
        )}
      </div>
      {failure && <Alert>{failure}</Alert>}
    </div>
  );
}
