"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogVariant } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { CATALOG_KEYS as K } from "../_lib/catalog-form";
import { MAX_SALES_CAP, parseSalesCap } from "../_lib/sales-cap";
import { Field } from "./catalog-ui";
import { Button, Input } from "../../_components/kit";

/**
 * A variant's sales cap (F-513-c, catalog `contract.sales-cap.md`): at most
 * this many sold, then the shop shows it sold out. What is sold and what
 * pending invoices hold is billing's count, shown beside it; a cap set under
 * them closes sales and undoes none (rule 3), so the page never refuses that.
 */
export function SalesCapSection({ variant: v, act }: { variant: CatalogVariant; act: (run: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useLocale();
  const { api } = useCatalogSurface();
  const { cap, sold, reserved, remaining } = v.sales;
  const [typed, setTyped] = useState(cap === null ? "" : String(cap));
  const [invalid, setInvalid] = useState(false);

  const save = () => {
    const next = parseSalesCap(typed);
    setInvalid(next === null);
    if (next !== null) void act(() => api.updateVariant(v.id, { salesCap: next }));
  };
  const clear = () => {
    setTyped("");
    setInvalid(false);
    void act(() => api.updateVariant(v.id, { salesCap: null }));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className={`text-2xs font-bold ${v.sales.soldOut ? "text-error" : "text-text-secondary"}`}>
        {cap === null ? t("common", K.salesCap.uncapped, { sold }) : t("common", K.salesCap.counts, { sold, reserved, remaining: remaining ?? 0 })}
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Field label={t("common", K.salesCap.label)} hint={t("common", K.salesCap.hint)}>
          <Input dir="ltr" inputMode="numeric" value={typed} aria-invalid={invalid || undefined} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <Button variant="primary" size="sm" onClick={save}>
          {t("common", K.salesCap.save)}
        </Button>
        {cap !== null && (
          <Button variant="quiet" size="sm" onClick={clear}>
            {t("common", K.salesCap.clear)}
          </Button>
        )}
      </div>
      {/* Field's own error takes a bare key; this sentence names billing's ceiling. */}
      {invalid && <p className="text-xs text-error">{t("common", K.salesCap.invalid, { max: MAX_SALES_CAP })}</p>}
    </div>
  );
}
