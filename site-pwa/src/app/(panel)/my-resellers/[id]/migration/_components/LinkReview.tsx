"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationItem, MigrationRun, MigrationRunsApi } from "@/lib/billing-api";
import { formatInstant } from "../../../../_lib/datetime";
import { MIGRATION_KEYS as K, reasonKey } from "../../../_lib/migration";
import { linkCorrectionBody, linkFormErrors, linkFormOf, type LinkForm } from "../../../_lib/migration-link";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { usePrepaidPlans } from "../_hooks/usePrepaidPlans";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { DatePicker } from "../../../../_components/kit/DatePicker";
import { Alert, Button, Field, Input, NativeSelect } from "../../../../_components/kit";

const GIB = 1024 ** 3;

/**
 * A previewed link run's one client (F-201-h-1, entitlement
 * `contract.link-import.md` rules 5–8): what the link said, the admin's
 * corrections beside it, the plan it becomes, and what the commit will do.
 * A save re-plans on billing's side and the card re-reads; the commit is the card's.
 */
export function LinkReview({ api, tenantId, run, onSaved }: { api: MigrationRunsApi; tenantId: string; run: MigrationRun; onSaved: (run: MigrationRun) => void }) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const { plans, error: plansError } = usePrepaidPlans(tenantId);
  const [item, setItem] = useState<MigrationItem | null>(null);
  const [edit, setEdit] = useState<Partial<LinkForm>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The run's every move re-plans its one item: read it again on each.
  useEffect(() => {
    let alive = true;
    api.outcomes(run.id, 1, 1, false).then(
      (page) => alive && setItem(page.rows[0] ?? null),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [api, run.id, run.updatedAt]);

  if (!item) return error !== null ? <Alert tone="error">{message(error)}</Alert> : <TableSkeleton rows={2} columns={2} />;

  const form: LinkForm = { ...linkFormOf(run, item), ...edit };
  const errors = linkFormErrors(form);
  const body = linkCorrectionBody(form, run, item);
  const changed = Object.keys(body).length > 0;
  const failure = error !== null ? error : plansError;
  const set = (patch: Partial<LinkForm>) => setEdit((e) => ({ ...e, ...patch }));

  async function save() {
    if (busy || !changed || Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.correctLink(run.id, body));
      setEdit({});
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby={`link-review-${run.id}`}>
      <h3 id={`link-review-${run.id}`} className="text-sm font-bold text-text-primary">
        {t("common", K.link.reviewTitle)}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("common", K.link.quotaGb)} hint={<ReadWas item={item} cell="quota" />} error={errors.quotaGb && t("common", errors.quotaGb)}>
          <Input type="number" min={0} step="any" dir="ltr" value={form.quotaGb} disabled={busy} onChange={(e) => set({ quotaGb: e.target.value })} />
        </Field>
        <Field label={t("common", K.link.usedGb)} hint={<ReadWas item={item} cell="used" />} error={errors.usedGb && t("common", errors.usedGb)}>
          <Input type="number" min={0} step="any" dir="ltr" value={form.usedGb} disabled={busy} onChange={(e) => set({ usedGb: e.target.value })} />
        </Field>
        <div className="space-y-1.5">
          <DatePicker label={t("common", K.link.end)} value={form.end} withTime onChange={(end) => set({ end })} />
          <p className="text-xs text-text-secondary">
            <ReadWas item={item} cell="end" />
          </p>
        </div>
        <Field label={t("common", K.link.product)}>
          <NativeSelect value={form.variantId} disabled={busy || plans === null} onChange={(e) => set({ variantId: e.target.value })}>
            <option value="">{t("common", K.link.pickProduct)}</option>
            {(plans ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {plans !== null && plans.length === 0 && <Alert tone="warning">{t("common", K.mapping.noOptions)}</Alert>}
      <Button size="sm" disabled={busy || !changed || Object.keys(errors).length > 0} onClick={() => void save()} icon={<Save size={14} aria-hidden />}>
        {t("common", busy ? K.link.saving : K.link.save)}
      </Button>
      <PlanNote item={item} run={run} />
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
    </section>
  );
}

/** What the link itself said for one figure, under the field the admin may change. */
function ReadWas({ item, cell }: { item: MigrationItem; cell: "quota" | "used" | "end" }) {
  const { t, lang } = useLocale();
  const gb = (bytes: number) => t("common", K.link.gb, { value: String(Math.round((bytes / GIB) * 100) / 100) });
  if (cell === "end") return <>{item.expiresAt ? t("common", K.link.readWas, { value: formatInstant(item.expiresAt, lang) ?? "" }) : t("common", K.link.noEnd)}</>;
  const bytes = cell === "quota" ? item.dataLimitBytes : item.usedBytes;
  if (bytes === null) return null;
  const value = cell === "quota" && bytes === 0 ? t("common", K.link.unlimited) : gb(bytes);
  return <>{t("common", K.link.readWas, { value })}</>;
}

/** What confirming would do, as billing planned it: create, nothing (already here), or why it is skipped. */
function PlanNote({ item, run }: { item: MigrationItem; run: MigrationRun }) {
  const { t } = useLocale();
  if (item.plannedAction === "update") return <Alert tone="info">{t("common", K.link.willUpdate)}</Alert>;
  if (item.plannedAction === "skip") {
    // A link's duplicate is a panel import that brought it, not a second inbound (contract.link-import.md rule 7).
    const key = item.skipReason === "duplicate" ? K.link.duplicate : reasonKey(K.skip, item.skipReason);
    return <Alert tone="warning">{key ? t("common", key) : item.skipReason}</Alert>;
  }
  return <Alert tone={run.variantId ? "success" : "info"}>{t("common", run.variantId ? K.link.willCreate : K.link.needProduct)}</Alert>;
}
