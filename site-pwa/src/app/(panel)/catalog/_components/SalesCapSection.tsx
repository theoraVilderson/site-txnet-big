"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogVariant } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { CATALOG_KEYS as K } from "../_lib/catalog-form";
import { MAX_SALES_CAP, parseSalesCap, type CapField } from "../_lib/sales-cap";
import { Field } from "./catalog-ui";
import { Button, Input } from "../../_components/kit";

type Act = (run: () => Promise<unknown>) => Promise<void>;

/**
 * One cap's box on a variant card: billing takes both caps as a whole number
 * 1..{@link MAX_SALES_CAP} or `null` (catalog `contract.sales-cap.md` "HTTP
 * surface"), so the box refuses anything else before the call. A cap set
 * under what is already counted closes sales and undoes none (rule 3, A2), so
 * the page never refuses that.
 */
function CapBox({ variant, act, field, cap, status, full }: { variant: CatalogVariant; act: Act; field: CapField; cap: number | null; status: string; full: boolean }) {
  const { t } = useLocale();
  const { api } = useCatalogSurface();
  const keys = K[field];
  const [typed, setTyped] = useState(cap === null ? "" : String(cap));
  const [invalid, setInvalid] = useState(false);

  const save = () => {
    const next = parseSalesCap(typed);
    setInvalid(next === null);
    if (next !== null) void act(() => api.updateVariant(variant.id, { [field]: next }));
  };
  const clear = () => {
    setTyped("");
    setInvalid(false);
    void act(() => api.updateVariant(variant.id, { [field]: null }));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className={`text-2xs font-bold ${full ? "text-error" : "text-text-secondary"}`}>{status}</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Field label={t("common", keys.label)} hint={t("common", keys.hint)}>
          <Input dir="ltr" inputMode="numeric" value={typed} aria-invalid={invalid || undefined} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <Button variant="primary" size="sm" onClick={save}>
          {t("common", keys.save)}
        </Button>
        {cap !== null && (
          <Button variant="quiet" size="sm" onClick={clear}>
            {t("common", keys.clear)}
          </Button>
        )}
      </div>
      {/* Field's own error takes a bare key; this sentence names billing's ceiling, the same for both caps. */}
      {invalid && <p className="text-xs text-error">{t("common", K.salesCap.invalid, { max: MAX_SALES_CAP })}</p>}
    </div>
  );
}

/**
 * A variant's sales cap (F-513-c): at most this many sold, then the shop shows
 * it sold out. What is sold and what pending invoices hold is billing's count.
 */
export function SalesCapSection({ variant: v, act }: { variant: CatalogVariant; act: Act }) {
  const { t } = useLocale();
  const { cap, sold, reserved, remaining, soldOut } = v.sales;
  const status = cap === null ? t("common", K.salesCap.uncapped, { sold }) : t("common", K.salesCap.counts, { sold, reserved, remaining: remaining ?? 0 });
  return <CapBox variant={v} act={act} field="salesCap" cap={cap} status={status} full={soldOut} />;
}

/**
 * A variant's active cap (F-514-d, catalog F-514): at most this many live
 * services at once. Live is counted from the Grants and a pending invoice
 * holds a slot (A1, A2), so the card shows live / cap, held and left.
 */
export function ActiveCapSection({ variant: v, act }: { variant: CatalogVariant; act: Act }) {
  const { t } = useLocale();
  const { cap, live, held, remaining, full } = v.active;
  const status = cap === null ? t("common", K.activeCap.uncapped, { live }) : t("common", K.activeCap.counts, { live, cap, held, remaining: remaining ?? 0 });
  return <CapBox variant={v} act={act} field="activeCap" cap={cap} status={status} full={full} />;
}
