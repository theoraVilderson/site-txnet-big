"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { catalogCostApi, type MeterCostLine, type MeterCostRow } from "@/lib/catalog-cost-api";
import { useCatalogSurface } from "../_lib/surface";
import { useMeterNames } from "../_lib/meter-names";
import { CATALOG_KEYS as K, rateDecimals } from "../_lib/catalog-form";
import { COST_FROM, currentCost, isCostSet, validateMeterCost, type CostFrom } from "../_lib/cost-form";
import { currencyDecimals, formatMoney } from "../../_lib/money";
import { numberLocale } from "../../_lib/digits";
import { Button, Card, EmptyState, Input, SegmentedControl } from "../../_components/kit";
import { Alert, Field } from "./catalog-ui";
import { UnsetCostAction, useCostWrite } from "./CostWrite";

const C = K.cost;
/** A form's first unit size, by the meter's unit: what a cost is usually quoted per. */
const DEFAULT_UNIT_SIZE: Record<MeterCostLine["unit"], string> = { count: "1000", tokens: "1000", seconds: "3600", bytes: "1073741824" };

/**
 * What a unit of each meter costs the tenant (F-1002-g, ADR-0151): API calls
 * bought from a supplier, seconds of a service. `vpn.traffic` is never here —
 * billing leaves it out, its cost is its panels'. One row per meter: the cost
 * in effect, and a new one from now or the 1st of this month — or the one in
 * effect taken back from the same starts (F-1002-j).
 */
export function MeterCostsTab() {
  const { t } = useLocale();
  const meterName = useMeterNames();
  const { tenantId } = useCatalogSurface();
  const api = useMemo(() => catalogCostApi(tenantId), [tenantId]);
  const [lines, setLines] = useState<MeterCostLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => api.meterCosts().then((l) => (setLines(l), setFailed(false)), () => setFailed(true)), [api]);
  useEffect(() => void load(), [load]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-secondary">{t("common", C.meters.intro)}</p>
      {failed && <Alert>{t("common", C.loadFailed)}</Alert>}
      {lines?.length === 0 && <EmptyState icon={Gauge} title={t("common", C.meters.empty)} />}
      {lines?.map((line) => <MeterCostCard key={line.meterKey} line={line} name={meterName(line.meterKey)} onSaved={load} />)}
    </div>
  );
}

function MeterCostCard({ line, name, onSaved }: { line: MeterCostLine; name: string; onSaved: () => Promise<unknown> }) {
  const { t, lang } = useLocale();
  const { tenantId } = useCatalogSurface();
  const [form, setForm] = useState({ unitSize: DEFAULT_UNIT_SIZE[line.unit], unitCost: "", from: "now" as CostFrom });
  const [invalid, setInvalid] = useState<ReturnType<typeof validateMeterCost>>({});
  const current = currentCost(line.costs);
  const shown = (c: MeterCostRow & { amount: string }) =>
    t("common", C.meters.perUnits, {
      cost: formatMoney(c.amount, c.currencyCode, { lang, t }, { decimals: rateDecimals(c.amount, currencyDecimals(c.currencyCode)) }),
      size: Number(c.unitSize).toLocaleString(numberLocale(lang)),
      unit: t("common", C.units[line.unit]),
    });

  const { error, write } = useCostWrite(form.from, onSaved);

  const save = async () => {
    const found = validateMeterCost(form);
    setInvalid(found);
    if (Object.keys(found).length) return;
    await write((start) =>
      catalogCostApi(tenantId)
        .setMeterCost({ meterKey: line.meterKey, unitSize: form.unitSize.trim(), unitCost: form.unitCost.trim(), ...start })
        .then(() => setForm((f) => ({ ...f, unitCost: "" }))),
    );
  };

  return (
    <Card className="flex flex-col gap-2 p-3">
      <p className="text-sm font-bold text-text-primary">
        {name}:{" "}
        {isCostSet(current) ? <span dir="auto">{shown(current)}</span> : <span className="text-error">{t("common", C.meters.none)}</span>}
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
        <Field label={t("common", C.meters.unitSize)} error={invalid.unitSize}>
          <Input dir="ltr" inputMode="numeric" value={form.unitSize} onChange={(e) => setForm((f) => ({ ...f, unitSize: e.target.value }))} />
        </Field>
        <Field label={t("common", C.meters.unitCost)} error={invalid.unitCost}>
          <Input dir="ltr" inputMode="decimal" value={form.unitCost} onChange={(e) => setForm((f) => ({ ...f, unitCost: e.target.value }))} />
        </Field>
        <Field label={t("common", C.from)}>
          <SegmentedControl
            size="sm"
            ariaLabel={t("common", C.from)}
            value={form.from}
            onChange={(from) => setForm((f) => ({ ...f, from }))}
            options={COST_FROM.map((f) => ({ value: f, label: t("common", f === "now" ? C.fromNow : C.fromMonthStart) }))}
          />
        </Field>
        <Button variant="primary" size="sm" onClick={() => void save()}>
          {t("common", C.save)}
        </Button>
      </div>
      {isCostSet(current) && <UnsetCostAction id={line.meterKey} onUnset={() => void write((start) => catalogCostApi(tenantId).unsetMeterCost(line.meterKey, start))} />}
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}
