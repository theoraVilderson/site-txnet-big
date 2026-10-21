"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRightLeft, Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { migrationRunsApi, type MigrationRun, type MigrationRunsApi, type Paged } from "@/lib/billing-api";
import { myResellerMigrationPath } from "@/lib/routes";
import { formatInstant } from "../../../../_lib/datetime";
import { driverLabel } from "../../../../systems/_lib/systems";
import { MIGRATION_KEYS as K, stageOf } from "../../../_lib/migration";
import { useWorkspaceSelf } from "../../../_lib/workspace";
import { useMigrationLive, useMigrationMessage } from "../_hooks/useMigrationLive";
import { MigrationRunCard } from "./MigrationRunCard";
import { SourceLoginForm } from "./SourceLoginForm";
import { Pagination } from "../../../../_components/kit/Pagination";
import { Alert, Button, Card, DataTable, EmptyState, PageHeader, StatusPill, type DataColumn } from "../../../../_components/kit";

const PAGE_SIZE = 10;

/**
 * `/my-resellers/:id/migration` — the reseller's import from another panel
 * (F-201-f, D-63; panel-web `contract.migration.md`). By the path's reseller,
 * never the session's tenant (ADR-0064): its owner signs in to the
 * platform's. Billing and tenant-service admit by `migration.manage` and the
 * page shows their refusal otherwise. `?run=` is the run open on screen, so
 * a reload or a shared link lands on it.
 */
export function MigrationView({ id }: { id: string }) {
  const { t } = useLocale();
  const router = useRouter();
  const runId = useSearchParams().get("run");
  const self = useWorkspaceSelf(id);
  const api = useMemo(() => migrationRunsApi(id), [id]);
  const [starting, setStarting] = useState(false);

  const root = myResellerMigrationPath(id, self);
  const open = (run: string | null) => {
    setStarting(false);
    router.replace(run ? `${root}?run=${encodeURIComponent(run)}` : root);
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <PageHeader
        icon={ArrowRightLeft}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          runId ? (
            <Button variant="quiet" size="sm" onClick={() => open(null)} icon={<ArrowLeft size={12} className="rtl:rotate-180" aria-hidden />}>
              {t("common", K.back)}
            </Button>
          ) : (
            !starting && (
              <Button size="sm" onClick={() => setStarting(true)} icon={<Plus size={12} aria-hidden />}>
                {t("common", K.newRun)}
              </Button>
            )
          )
        }
      />
      {runId && <MigrationRunCard key={runId} api={api} tenantId={id} runId={runId} />}
      {!runId && starting && (
        <Card>
          <SourceLoginForm api={api} run={null} onDone={(run) => open(run.id)} onCancel={() => setStarting(false)} />
        </Card>
      )}
      {!runId && <MigrationHistory api={api} tenantId={id} onOpen={open} onStart={() => setStarting(true)} />}
    </div>
  );
}

/** Every run of this reseller, newest first; live, as each one moves. */
function MigrationHistory({ api, tenantId, onOpen, onStart }: { api: MigrationRunsApi; tenantId: string; onOpen: (runId: string) => void; onStart: () => void }) {
  const { t, lang } = useLocale();
  const message = useMigrationMessage();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<MigrationRun> | null>(null);
  const [error, setError] = useState<unknown>(null);

  const read = useCallback(() => {
    api.list(page, PAGE_SIZE).then(
      (p) => {
        setData(p);
        setError(null);
      },
      (e: unknown) => setError(e),
    );
  }, [api, page]);
  useEffect(read, [read]);
  useMigrationLive(tenantId, read);

  const columns: DataColumn<MigrationRun>[] = [
    {
      id: "source",
      header: t("common", K.historyCol.source),
      cell: (r) => (
        <button type="button" className="text-start font-bold text-primary hover:underline" dir="auto" onClick={() => onOpen(r.id)}>
          {t("common", K.historyRow, { family: driverLabel(r.sourceFamily), address: r.sourceAddress })}
        </button>
      ),
    },
    { id: "status", header: t("common", K.historyCol.status), cell: (r) => <StatusPill tone={stageOf(r) === "imported" ? "success" : "neutral"}>{t("common", K.status[r.status])}</StatusPill> },
    {
      id: "counts",
      header: t("common", K.historyCol.counts),
      cell: (r) => t("common", K.report.counts, { create: String(r.plannedCreate), update: String(r.plannedUpdate), skip: String(r.plannedSkip) }),
    },
    { id: "started", header: t("common", K.historyCol.started), hideOnCard: true, cell: (r) => formatInstant(r.createdAt, lang) ?? "" },
  ];

  if (error !== null) return <Alert tone="error">{message(error)}</Alert>;
  if (!data) return null;
  if (data.total === 0)
    return (
      <EmptyState
        icon={ArrowRightLeft}
        title={t("common", K.history)}
        body={t("common", K.historyEmpty)}
        action={
          <Button size="sm" onClick={onStart} icon={<Plus size={12} aria-hidden />}>
            {t("common", K.newRun)}
          </Button>
        }
      />
    );
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-bold text-text-primary">{t("common", K.history)}</h2>
      <DataTable label={t("common", K.history)} rows={data.rows} columns={columns} rowKey={(r) => r.id} />
      <Pagination page={page} totalPages={Math.ceil(data.total / PAGE_SIZE)} totalItems={data.total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </section>
  );
}
