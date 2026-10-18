"use client";

import { useState } from "react";
import { ChevronDown, Power } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogPrice, CatalogVariant, FulfilmentKind, Quotas } from "@/lib/catalog-api";
import { useCatalogSurface, usePricedIn } from "../_lib/surface";
import { DatePicker } from "../../_components/kit/DatePicker";
import { DataTable } from "../../_components/kit/DataTable";
import { formatInstant, platformToday } from "../../_lib/datetime";
import {
  CATALOG_KEYS as K,
  currentPrice,
  noRate,
  notForSale,
  panelGroupPatch,
  takesPanelGroup,
  priceBody,
  quotaToInput,
  validatePriceForm,
  pricedIn,
  type Errors,
  type PriceForm,
} from "../_lib/catalog-form";
import { RateCardSection, RegenerateCardSection } from "./RateCardSection";
import { VariantCostSection } from "./VariantCostSection";
import { SalesCapSection } from "./SalesCapSection";
import { PanelGroupSelect, type PanelGroups } from "./PanelGroupSelect";
import { CopyId, Field, useMessage } from "./catalog-ui";
import { Alert, Button, Input } from "../../_components/kit";

/** A variant's quotas in one line: `50 GB · 2 devices`. */
function QuotaSummary({ quotas }: { quotas: Quotas }) {
  const { t } = useLocale();
  const parts = Object.entries(quotas).flatMap(([metric, q]) =>
    !q
      ? []
      : metric === "traffic_bytes"
        ? [t("common", K.variant.gb, { count: quotaToInput("traffic_bytes", String(q.limit)) })]
        : [`${t("common", K.metric[metric as keyof typeof K.metric])}: ${q.limit}`],
  );
  return parts.length ? <>{` · ${parts.join(" · ")}`}</> : null;
}

export function VariantCard({
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
  const currency = usePricedIn();
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
    const today = platformToday();
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
          <p className="text-2xs text-text-secondary">
            {t("common", K.visibility[v.visibility])} · {t("common", K.billingMode[v.billingMode])} ·{" "}
            {v.durationDays === null ? t("common", K.variant.permanent) : t("common", K.variant.days, { count: v.durationDays })}
            <QuotaSummary quotas={v.quotas} />
            {!v.isActive && ` · ${t("common", K.inactive)}`}
          </p>
          {notForSale(v, kind) && <p className="mt-1 text-2xs font-bold text-error">{t("common", K.variant.notForSale)}</p>}
          {noRate(v, now) && <p className="mt-1 text-2xs font-bold text-error">{t("common", K.rateCard.none)}</p>}
          {v.sales.soldOut && <p className="mt-1 text-2xs font-bold text-error">{t("common", K.salesCap.soldOut)}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-xs font-bold text-primary">
            {current ? money(current) : t("common", K.price.noPrice)}
          </span>
          <CopyId id={v.id} />
          <Button variant="quiet" size="sm" onClick={() => void act(() => api.updateVariant(v.id, { isActive: !v.isActive }))} icon={<Power size={14} aria-hidden />}>
            {t("common", v.isActive ? K.deactivate : K.activate)}
          </Button>
        </div>
      </div>

      {takesPanelGroup(kind) && (
        <PanelGroupSelect value={v.panelGroupId ?? ""} groups={groups} onChange={(id) => void act(() => api.updateVariant(v.id, panelGroupPatch(id)))} />
      )}

      <SalesCapSection variant={v} act={act} />
      {v.billingMode === "metered" && <RateCardSection variant={v} act={act} />}
      {takesPanelGroup(kind) && <RegenerateCardSection variant={v} act={act} />}
      <VariantCostSection variantId={v.id} />

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label={pricedIn(t("common", K.price.amount), currency)} error={errors.amount}>
          <Input dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
        </Field>
        <Field label={t("common", K.price.day)} error={errors.day} hint={t("common", K.price.dayHint)}>
          <DatePicker value={form.day || null} onChange={(d) => setForm((f) => ({ ...f, day: d ?? "" }))} />
        </Field>
        <Button variant="primary" size="sm" onClick={() => void newPrice()}>
          {t("common", K.newPrice)}
        </Button>
      </div>

      <Button variant="quiet" size="sm" className="self-start" aria-expanded={history} onClick={() => setHistory((h) => !h)} icon={<ChevronDown size={14} className={history ? "rotate-180" : ""} aria-hidden />}>
        {t("common", K.price.history)} ({v.prices.length})
      </Button>
      {history && (
        <DataTable
          label={t("common", K.price.history)}
          compact
          bare
          rows={v.prices}
          rowKey={(p) => p.id}
          columns={[
              { id: "price", header: t("common", K.price.amount), cell: money },
              { id: "from", header: t("common", K.price.day), cell: (p) => t("common", K.price.effectiveFrom, { time: formatInstant(p.effectiveFrom, lang) ?? "" }) },
              {
                id: "state",
                header: t("common", K.price.state),
                cell: (p) =>
                  p.id === current?.id ? t("common", K.price.current) : !p.isActive ? t("common", K.inactive) : new Date(p.effectiveFrom) > now ? t("common", K.price.scheduled) : "",
              },
          ]}
          actions={(p) => (p.isActive ? [{ id: "deactivate", label: t("common", K.deactivate), onSelect: () => void act(() => api.deactivatePrice(p.id)) }] : [])}
        />
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </section>
  );
}

