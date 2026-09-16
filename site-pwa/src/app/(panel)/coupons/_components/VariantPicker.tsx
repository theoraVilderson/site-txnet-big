"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { catalogApi, type CatalogProductDetail } from "@/lib/catalog-api";
import { Select } from "../../_components/kit/Select";
import { COUPON_KEYS } from "../_lib/coupon-form";
import { variantChoices } from "../_lib/variant-choices";

const P = COUPON_KEYS.form.variantPicker;

const input =
  "w-full rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2.5 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-[var(--accent-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)] disabled:opacity-60";

/**
 * The variant a free-service coupon or gift batch gives (F-502-l-c).
 *
 * The catalog is read through `/api/catalog`, which needs `catalog.manage`. A
 * coupon manager without it — or a reseller giving a platform variant, which
 * that route does not list to a tenant — still has the ID field: the picker
 * falls back to it on a failed read, and a link switches to it by hand. A
 * saved value the list does not hold opens by hand too, so an edit never
 * blanks it.
 */
export function VariantPicker({
  id,
  value,
  onChange,
  ownerTenant,
  invalid = false,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  ownerTenant: string | null;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const [catalog, setCatalog] = useState<CatalogProductDetail[] | null | "failed">(null);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let live = true;
    catalogApi
      .products()
      .then((products) => Promise.all(products.map((p) => catalogApi.product(p.id))))
      .then(
        (details) => live && setCatalog(details),
        () => live && setCatalog("failed"),
      );
    return () => {
      live = false;
    };
  }, []);

  const choices = useMemo(() => (Array.isArray(catalog) ? variantChoices(catalog, ownerTenant) : []), [catalog, ownerTenant]);
  const unknownValue = Array.isArray(catalog) && value.trim() !== "" && !choices.some((c) => c.value === value.trim());
  const byHand = catalog === "failed" || manual || unknownValue;

  const toggle = (label: string, next: boolean) =>
    catalog !== "failed" &&
    !disabled && (
      <button
        type="button"
        onClick={() => {
          setManual(next);
          if (!next && unknownValue) onChange("");
        }}
        className="self-start text-[11px] font-bold text-primary hover:underline"
      >
        {label}
      </button>
    );

  if (catalog === null) return <p className="py-2.5 text-xs text-text-secondary">{t("common", P.loading)}</p>;

  if (byHand)
    return (
      <div className="flex flex-col gap-1">
        <input
          id={id}
          dir="ltr"
          disabled={disabled}
          aria-invalid={invalid}
          className={`${input} ${invalid ? "border-error focus:border-error" : ""}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {toggle(t("common", P.pick), false)}
      </div>
    );

  const duration = (d: number | null) => (d === null ? t("common", P.permanent) : t("common", P.days, { n: d }));
  return (
    <div className="flex flex-col gap-1">
      {choices.length === 0 ? (
        <p className="py-2.5 text-xs text-text-secondary">{t("common", P.empty)}</p>
      ) : (
        <Select
          id={id}
          value={value}
          onChange={onChange}
          invalid={invalid}
          disabled={disabled}
          placeholder={t("common", P.placeholder)}
          options={choices.map((c) => ({ value: c.value, label: `${c.product} › ${c.sku} · ${duration(c.durationDays)}` }))}
        />
      )}
      {toggle(t("common", P.manual), true)}
    </div>
  );
}
