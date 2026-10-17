"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { catalogCostApi, type CostRow } from "@/lib/catalog-cost-api";
import { useCatalogSurface } from "../_lib/surface";
import { CATALOG_KEYS as K } from "../_lib/catalog-form";
import { COST_FROM, costFrom, currentCost, validateVariantCost, type CostFrom } from "../_lib/cost-form";
import { DataTable } from "../../_components/kit/DataTable";
import { formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import { Button, Input, SegmentedControl } from "../../_components/kit";
import { Alert, Field, useMessage } from "./catalog-ui";

const C = K.cost;

/**
 * What one sale of a variant costs its tenant (F-1002-g, ADR-0151): the cost
 * in effect — or "no cost set", which is what makes a product read as 100%
 * margin — a new one from now or the 1st of this month, and the history. A
 * cost is never edited; a new row replaces it from its day. Private to the
 * tenant: billing answers this surface's own variants only.
 */
export function VariantCostSection({ variantId, now = new Date() }: { variantId: string; now?: Date }) {
  const { t, lang } = useLocale();
  const message = useMessage();
  const { tenantId } = useCatalogSurface();
  const api = useMemo(() => catalogCostApi(tenantId), [tenantId]);
  const [rows, setRows] = useState<CostRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState<CostFrom>("now");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false);

  const load = useCallback(
    () =>
      api.variantCosts(variantId).then(
        (r) => (setRows(r), setFailed(false)),
        () => setFailed(true),
      ),
    [api, variantId],
  );
  useEffect(() => void load(), [load]);

  const current = rows ? currentCost(rows, now) : null;
  const money = (r: CostRow) => formatMoney(r.amount, r.currencyCode, { lang, t });

  const save = async () => {
    const found = validateVariantCost(amount);
    setInvalid(found);
    if (found) return;
    setError(null);
    const effectiveFrom = costFrom(from, now);
    try {
      await api.setVariantCost(variantId, { amount: amount.trim(), ...(effectiveFrom ? { effectiveFrom } : {}) });
      setAmount("");
      await load();
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-bg-inner p-2">
      <p className="text-xs font-bold text-text-primary">
        {t("common", C.title)}:{" "}
        {rows === null ? null : current ? <span dir="auto">{money(current)}</span> : <span className="text-error">{t("common", C.none)}</span>}
      </p>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Field label={t("common", C.amount)} error={invalid ?? undefined} hint={t("common", C.hint)}>
          <Input dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label={t("common", C.from)} hint={t("common", C.fromHint)}>
          <SegmentedControl
            size="sm"
            ariaLabel={t("common", C.from)}
            value={from}
            onChange={setFrom}
            options={COST_FROM.map((f) => ({ value: f, label: t("common", f === "now" ? C.fromNow : C.fromMonthStart) }))}
          />
        </Field>
        <Button variant="primary" size="sm" onClick={() => void save()}>
          {t("common", C.save)}
        </Button>
      </div>

      {rows && rows.length > 0 && (
        <Button variant="quiet" size="sm" className="self-start" aria-expanded={history} onClick={() => setHistory((h) => !h)} icon={<ChevronDown size={14} className={history ? "rotate-180" : ""} aria-hidden />}>
          {t("common", C.history)} ({rows.length})
        </Button>
      )}
      {history && rows && (
        <DataTable
          label={t("common", C.history)}
          compact
          bare
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            { id: "amount", header: t("common", C.amount), cell: money },
            { id: "from", header: t("common", C.from), cell: (r) => t("common", C.effectiveFrom, { time: formatInstant(r.effectiveFrom, lang) ?? "" }) },
            { id: "state", header: "", cell: (r) => (r.id === current?.id ? t("common", C.current) : new Date(r.effectiveFrom) > now ? t("common", C.scheduled) : "") },
          ]}
        />
      )}
      {failed && <Alert>{t("common", C.loadFailed)}</Alert>}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
