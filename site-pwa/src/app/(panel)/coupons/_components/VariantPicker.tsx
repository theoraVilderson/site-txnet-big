"use client";

import { useMemo, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { Select } from "../../_components/kit/Select";
import { COUPON_KEYS } from "../_lib/coupon-form";
import { variantChoices } from "../_lib/variant-choices";
import { readCatalogDetails, useChoiceList } from "../_hooks/useChoiceList";
import type { Choices } from "./ChoicePicker";
import { Button, Input } from "../../_components/kit";

const P = COUPON_KEYS.form.variantPicker;


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
  const catalog = useVariantOptions(ownerTenant);
  const [manual, setManual] = useState(false);

  const choices = Array.isArray(catalog) ? catalog : [];
  const unknownValue = Array.isArray(catalog) && value.trim() !== "" && !choices.some((c) => c.value === value.trim());
  const byHand = catalog === "failed" || manual || unknownValue;

  const toggle = (label: string, next: boolean) =>
    catalog !== "failed" &&
    !disabled && (
      <Button
        variant="quiet"
        size="sm"
        onClick={() => {
          setManual(next);
          if (!next && unknownValue) onChange("");
        }}
        className="self-start text-primary hover:text-primary"
      >
        {label}
      </Button>
    );

  if (catalog === null) return <p className="py-2.5 text-xs text-text-secondary">{t("common", P.loading)}</p>;

  if (byHand)
    return (
      <div className="flex flex-col gap-1">
        <Input
          id={id}
          dir="ltr"
          disabled={disabled}
          aria-invalid={invalid}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {toggle(t("common", P.pick), false)}
      </div>
    );

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
          options={choices}
        />
      )}
      {toggle(t("common", P.manual), true)}
    </div>
  );
}

/**
 * The live variants `ownerTenant` may name (`variantChoices`), each labelled
 * "product › sku · duration" — the free-service picker's list and a coupon's
 * variant scope (UX-3-a). `null` while the catalog loads, `"failed"` when the
 * caller may not read it.
 */
export function useVariantOptions(ownerTenant: string | null): Choices {
  const { t } = useLocale();
  const catalog = useChoiceList(readCatalogDetails);
  return useMemo(() => {
    if (!Array.isArray(catalog)) return catalog;
    const duration = (d: number | null) => (d === null ? t("common", P.permanent) : t("common", P.days, { n: d }));
    return variantChoices(catalog, ownerTenant).map((c) => ({ value: c.value, label: `${c.product} › ${c.sku} · ${duration(c.durationDays)}` }));
  }, [catalog, ownerTenant, t]);
}
