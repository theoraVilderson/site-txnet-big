"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationItem, MigrationRun, MigrationRunsApi, Paged } from "@/lib/billing-api";
import { formatInstant } from "../../../../_lib/datetime";
import { formatBytes } from "../../../../services/_lib/service-configs";
import { MIGRATION_KEYS as K, reasonKey } from "../../../_lib/migration";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { Pagination } from "../../../../_components/kit/Pagination";
import { Alert, Badge, DataTable, SegmentedControl, type DataColumn, type Tone } from "../../../../_components/kit";

const PAGE_SIZE = 20;

const ACTION_TONE: Record<MigrationItem["plannedAction"], Tone> = { create: "success", update: "info", skip: "warning" };
const OUTCOME_TONE: Record<MigrationItem["outcome"], Tone> = {
  pending: "neutral",
  created: "success",
  updated: "info",
  skipped: "warning",
  failed: "error",
  rolled_back: "neutral",
  kept: "info",
};

/** Before the commit nothing has an outcome yet: the table shows the plan alone. */
const hasOutcomes = (run: MigrationRun) => !["draft", "previewing", "previewed", "cancelled", "expired"].includes(run.status);

/**
 * The dry run's per-user table (F-206's report), and after the commit what
 * each user came to (F-207) and what a rollback kept, with why (F-211). It
 * reads again whenever the run moves (`updatedAt`), which the card hears
 * live; "problems" narrows to the skipped, the failed and the kept.
 */
export function MigrationReport({ api, run }: { api: MigrationRunsApi; run: MigrationRun }) {
  const { t, lang } = useLocale();
  const message = useMigrationMessage();
  const [problems, setProblems] = useState(hasOutcomes(run));
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<MigrationItem> | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    api.outcomes(run.id, page, PAGE_SIZE, problems).then(
      (p) => {
        if (!alive) return;
        setData(p);
        setError(null);
      },
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [api, run.id, run.updatedAt, page, problems]);

  const tagOf = new Map((run.inbounds ?? []).map((i) => [i.inboundRemoteId, i.tag]));
  const why = (table: Readonly<Record<string, string>>, reason: string | null) => {
    if (reason === null) return null;
    const key = reasonKey(table, reason);
    return key ? t("common", key) : reason;
  };
  const traffic = (r: MigrationItem) => {
    if (r.usedBytes === null && r.dataLimitBytes === null) return "—";
    const used = formatBytes(r.usedBytes === null ? null : String(r.usedBytes), lang) ?? "—";
    const limit = r.dataLimitBytes === 0 ? t("common", K.report.unlimited) : (formatBytes(r.dataLimitBytes === null ? null : String(r.dataLimitBytes), lang) ?? "—");
    return `${used} / ${limit}`;
  };

  const columns: DataColumn<MigrationItem>[] = [
    {
      id: "user",
      header: t("common", K.report.col.user),
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1" dir="auto">
          <span className="font-bold text-text-primary">{r.label || r.remoteIdentity}</span>
          {r.enabled === false && <Badge tone="neutral">{t("common", K.report.off)}</Badge>}
        </span>
      ),
    },
    { id: "inbound", header: t("common", K.report.col.inbound), dir: "auto", cell: (r) => (r.inboundRemoteId ? (tagOf.get(r.inboundRemoteId) ?? r.inboundRemoteId) : "—") },
    { id: "traffic", header: t("common", K.report.col.traffic), dir: "ltr", cell: traffic },
    {
      id: "expires",
      header: t("common", K.report.col.expires),
      cell: (r) => (r.expiresAt ? (formatInstant(r.expiresAt, lang, { withTime: false }) ?? "—") : t("common", K.report.noEnd)),
    },
    {
      id: "plan",
      header: t("common", K.report.col.plan),
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          <Badge tone={ACTION_TONE[r.plannedAction]}>{t("common", K.action[r.plannedAction])}</Badge>
          {r.skipReason && <span className="text-xs text-text-secondary">{why(K.skip, r.skipReason)}</span>}
        </span>
      ),
    },
  ];
  if (hasOutcomes(run))
    columns.push({
      id: "result",
      header: t("common", K.report.col.result),
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          <Badge tone={OUTCOME_TONE[r.outcome]}>{t("common", K.outcome[r.outcome])}</Badge>
          {(r.failureReason ?? r.keptReason) && <span className="text-xs text-text-secondary">{why(r.failureReason ? K.itemFailure : K.kept, r.failureReason ?? r.keptReason)}</span>}
        </span>
      ),
    });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-bold text-text-primary">{t("common", K.report.title)}</h3>
        <SegmentedControl
          size="sm"
          ariaLabel={t("common", K.report.title)}
          value={problems ? "problems" : "all"}
          onChange={(v) => {
            setProblems(v === "problems");
            setPage(1);
          }}
          options={[
            { value: "all", label: t("common", K.report.all) },
            { value: "problems", label: t("common", K.report.problemsOnly) },
          ]}
        />
      </div>
      {run.snapshotsPurgedAt && <Alert tone="info">{t("common", K.report.purged)}</Alert>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      {data && (
        <>
          <DataTable label={t("common", K.report.label)} rows={data.rows} columns={columns} rowKey={(r) => r.remoteIdentity} compact empty={<p className="p-4 text-sm text-text-secondary">{t("common", K.report.empty)}</p>} />
          <Pagination page={page} totalPages={Math.ceil(data.total / PAGE_SIZE)} totalItems={data.total} pageSize={PAGE_SIZE} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}
