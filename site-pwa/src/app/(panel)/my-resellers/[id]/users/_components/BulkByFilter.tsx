"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { resellerGrantsApi, type BulkJob, type BulkOutcomeRow, type BulkPanel } from "@/lib/billing-api";
import { catalogAdminApi, catalogApi } from "@/lib/catalog-api";
import { Pagination } from "../../../../_components/kit/Pagination";
import { formatInstant } from "../../../../_lib/datetime";
import { Alert, input, primaryButton, quietButton } from "../../../../catalog/_components/catalog-ui";
import { flattenTexts } from "../../../../catalog/_lib/catalog-form";
import { GRANT_KEYS as G, emptyDraft, type GrantActionDraft } from "../../../_lib/grant-actions";
import {
  BULK_ACTIONS,
  BULK_ACTION_NAMES,
  JOB_KEYS as J,
  JOB_POLL_MS,
  bulkJobBody,
  bulkRefusalKey,
  filterOf,
  jobPercent,
  type BulkAction,
  type BulkScope,
} from "../../../_lib/grant-bulk";
import { USER_KEYS } from "../../../_lib/users";
import { ActionFields } from "../[userId]/_components/GrantActions";
import { useUserMessage } from "../[userId]/_components/useUserMessage";

const JOBS_PAGE_SIZE = 10;
const OUTCOMES_PAGE_SIZE = 20;
/** billing's `GRANT_BULK_JOB_MAX_GRANTS`: past it the start is refused, so the confirm says so first. */
const MAX_JOB_GRANTS = 100_000;
const panel = "space-y-2 rounded-2xl border border-card-border bg-bg-inner p-3";
const button = "inline-flex items-center gap-1 rounded-xl border border-card-border bg-card-bg px-2.5 py-1.5 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50";
const STATUS_TONE: Record<BulkJob["status"], string> = {
  running: "border-primary/20 bg-leaf-bg text-primary",
  done: "border-card-border bg-bg-inner text-text-secondary",
  cancelled: "border-gold/20 bg-gold-bg text-gold",
};
const ACTION_OF: Record<string, BulkAction> = Object.fromEntries(BULK_ACTIONS.map((a) => [BULK_ACTION_NAMES[a], a]));

interface Product {
  id: string;
  label: string;
  variants: { id: string; label: string }[];
}

/**
 * One act on a reseller's services chosen by a filter (F-311-x1 over billing's
 * `grants/bulk-jobs`, F-311-u2/-u3) — every active service, a panel, a product
 * or one of its plans: after an outage a panel can hold thousands.
 *
 *  - **the confirm shows the count now**, and billing freezes that selection
 *    when the job starts; a service matching later is not in it;
 *  - **one form, one `requestId`**: a double click answers the same job;
 *  - **the job runs in the worker**: its progress is read again while any job
 *    on the page runs, it can be stopped (what was done stands), and its
 *    refused services are listed with their sentence until billing purges them.
 */
export function BulkByFilter({ id }: { id: string }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();
  const api = useMemo(() => resellerGrantsApi(id), [id]);

  const [open, setOpen] = useState<BulkAction | null>(null);
  const [draft, setDraft] = useState<GrantActionDraft>(emptyDraft);
  const [kind, setKind] = useState<BulkScope["kind"]>("all");
  const [panelId, setPanelId] = useState("");
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [panels, setPanels] = useState<BulkPanel[] | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  // The count answered for one filter: a stale one never reads as the current pick's.
  const [counted, setCounted] = useState<{ key: string; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [jobs, setJobs] = useState<{ rows: BulkJob[]; total: number } | null>(null);
  const [jobsPage, setJobsPage] = useState(1);
  const [jobsAsked, setJobsAsked] = useState(0);
  const [jobsError, setJobsError] = useState<unknown>(null);

  const scope: BulkScope | null =
    kind === "all"
      ? { kind: "all" }
      : kind === "panel"
        ? panelId
          ? { kind: "panel", panelId }
          : null
        : productId
          ? variantId
            ? { kind: "variant", productId, variantId }
            : { kind: "product", productId }
          : null;
  const filter = open && scope ? filterOf(scope, open) : null;
  // Per opened form too: a form opened again counts again, never shows the last one's number.
  const requestId = draft.requestId;
  const filterJson = filter ? JSON.stringify(filter) : null;
  const filterKey = filterJson === null ? null : `${requestId} ${filterJson}`;
  const count = counted !== null && counted.key === filterKey ? counted.n : null;
  const body = open && count !== null && count > 0 && count <= MAX_JOB_GRANTS ? bulkJobBody(open, filter, draft) : null;

  // The panels and the catalog are read the first time they are picked — the panels also when a job names one.
  const jobNamesPanel = jobs?.rows.some((j) => j.filter.panelId) ?? false;
  useEffect(() => {
    if ((kind !== "panel" && !jobNamesPanel) || panels !== null) return;
    api.bulkPanels().then(setPanels).catch(setError);
  }, [api, kind, jobNamesPanel, panels]);

  useEffect(() => {
    if (kind !== "product" || products !== null) return;
    let alive = true;
    const catalog = catalogAdminApi(id);
    Promise.all([catalog.products(), catalogApi.texts(lang).then(flattenTexts).catch(() => ({}) as Record<string, string>)])
      .then(async ([list, texts]) => {
        // Every product and plan: a service sold before one was switched off is still its.
        const details = await Promise.all(list.map((p) => catalog.product(p.id)));
        return details.map((p) => ({
          id: p.id,
          label: texts[p.nameKey] || p.variants[0]?.sku || p.id.slice(0, 8),
          variants: p.variants.map((v) => ({ id: v.id, label: texts[v.nameKey ?? p.nameKey] ? `${texts[v.nameKey ?? p.nameKey]} · ${v.sku}` : v.sku })),
        }));
      })
      .then((ps) => alive && setProducts(ps))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id, kind, lang, products]);

  // The count follows the pick: what the confirm shows.
  useEffect(() => {
    if (filterJson === null) return;
    let alive = true;
    api
      .bulkCount(JSON.parse(filterJson))
      .then((n) => alive && setCounted({ key: `${requestId} ${filterJson}`, n }))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [api, requestId, filterJson]);

  const readJobs = useCallback(
    () =>
      api
        .bulkJobs(jobsPage, JOBS_PAGE_SIZE)
        .then((p) => {
          setJobs({ rows: p.rows, total: p.total });
          setJobsError(null);
        })
        .catch(setJobsError),
    [api, jobsPage],
  );

  useEffect(() => {
    void readJobs();
  }, [readJobs, jobsAsked]);

  // Read again while a job on this page runs; stop once none does.
  const running = jobs?.rows.some((j) => j.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void readJobs(), JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [running, readJobs]);

  function start(action: BulkAction) {
    setOpen(action);
    // A new form, a new request: the same form sent twice starts one job.
    setDraft(emptyDraft());
    setError(null);
  }

  async function submit() {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.bulkStart(body);
      setOpen(null);
      setJobsPage(1);
      setJobsAsked((n) => n + 1);
    } catch (e) {
      console.error(e);
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<GrantActionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const product = products?.find((p) => p.id === productId);

  function filterLabel(job: BulkJob): string {
    const f = job.filter;
    const named = (list: { id: string; label: string }[] | undefined, fid: string) => list?.find((x) => x.id === fid)?.label ?? fid.slice(0, 8);
    const what = f.panelId
      ? t("common", J.filterPanel, { name: panels?.find((p) => p.id === f.panelId)?.name ?? f.panelId.slice(0, 8) })
      : f.variantId
        ? t("common", J.filterVariant, { name: named(products?.flatMap((p) => p.variants), f.variantId) })
        : f.productId
          ? t("common", J.filterProduct, { name: named(products ?? undefined, f.productId) })
          : t("common", J.filterAll);
    return f.statuses.includes("suspended") ? `${what} · ${t("common", J.unfrozen)}` : what;
  }

  return (
    <section aria-label={t("common", J.title)} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <p className="text-sm font-bold text-text-primary">{t("common", J.title)}</p>
        <p className="mt-1 text-xs text-text-secondary">{t("common", J.subtitle)}</p>
      </div>

      <div className="flex flex-wrap gap-1">
        {BULK_ACTIONS.map((action) => (
          <button key={action} type="button" className={button} disabled={busy} aria-pressed={open === action} onClick={() => start(action)}>
            {t("common", G.label[action])}
          </button>
        ))}
      </div>

      {open && (
        <form
          className={panel}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-xs text-text-secondary">{t("common", G.confirm[open])}</p>

          <fieldset className="space-y-1">
            <legend className="text-xs font-bold text-text-secondary">{t("common", J.scope.label)}</legend>
            <div className="flex flex-wrap gap-3 text-xs text-text-primary">
              {(["all", "panel", "product"] as const).map((k) => (
                <label key={k} className="inline-flex items-center gap-1">
                  <input type="radio" name="bulk-scope" checked={kind === k} onChange={() => setKind(k)} />
                  {t("common", J.scope[k])}
                </label>
              ))}
            </div>
          </fieldset>

          {kind === "panel" &&
            (panels === null ? (
              <p className="text-xs text-text-secondary">{t("common", J.loading)}</p>
            ) : panels.length === 0 ? (
              <p className="text-xs text-text-secondary">{t("common", J.noPanels)}</p>
            ) : (
              <select className={input} value={panelId} aria-label={t("common", J.panelPick)} onChange={(e) => setPanelId(e.target.value)}>
                <option value="">{t("common", J.panelPick)}</option>
                {panels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t("common", J.panelOption, { name: p.name, region: p.region, count: p.grants })}
                    {p.own ? ` · ${t("common", J.own)}` : ""}
                    {p.retired ? ` · ${t("common", J.retired)}` : ""}
                  </option>
                ))}
              </select>
            ))}

          {kind === "product" &&
            (products === null ? (
              <p className="text-xs text-text-secondary">{t("common", J.loading)}</p>
            ) : products.length === 0 ? (
              <p className="text-xs text-text-secondary">{t("common", J.noProducts)}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <select
                  className={input}
                  value={productId}
                  aria-label={t("common", J.productPick)}
                  onChange={(e) => {
                    setProductId(e.target.value);
                    setVariantId("");
                  }}
                >
                  <option value="">{t("common", J.productPick)}</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {product && product.variants.length > 1 && (
                  <select className={input} value={variantId} aria-label={t("common", J.variantAll)} onChange={(e) => setVariantId(e.target.value)}>
                    <option value="">{t("common", J.variantAll)}</option>
                    {product.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}

          {open === "unfreeze" && <p className="text-xs text-text-secondary">{t("common", J.unfreezeNote)}</p>}
          {filter !== null && (
            <p className="text-xs font-bold text-text-primary" role="status">
              {count === null
                ? t("common", J.counting)
                : count === 0
                  ? t("common", J.countEmpty)
                  : count > MAX_JOB_GRANTS
                    ? t("common", J.tooLarge, { max: MAX_JOB_GRANTS })
                    : t("common", J.count, { count })}
            </p>
          )}

          <ActionFields action={open} draft={draft} set={set} />
          <label className="block text-xs font-bold text-text-secondary">
            {t("common", G.field.reason)}
            <input
              className={`${input} mt-1`}
              value={draft.reason}
              maxLength={500}
              placeholder={t("common", G.field.reasonPlaceholder)}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </label>
          {body !== null && <p className="text-xs text-text-secondary">{t("common", J.confirm, { count: count ?? 0 })}</p>}
          <div className="flex gap-2">
            <button type="submit" className={primaryButton} disabled={busy || body === null}>
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
              {t("common", J.submit, { count: count ?? 0 })}
            </button>
            <button type="button" className={quietButton} onClick={() => setOpen(null)}>
              {t("common", USER_KEYS.actions.cancel)}
            </button>
          </div>
        </form>
      )}
      {error !== null && <Alert>{message(error)}</Alert>}

      <div className="space-y-2">
        <p className="text-xs font-bold text-text-secondary">{t("common", J.jobsTitle)}</p>
        {jobsError !== null && <Alert>{message(jobsError)}</Alert>}
        {jobs !== null &&
          (jobs.rows.length === 0 ? (
            <p className="text-xs text-text-secondary">{t("common", J.jobsEmpty)}</p>
          ) : (
            <>
              <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border">
                {jobs.rows.map((job) => (
                  <JobRow key={job.id} job={job} api={api} label={filterLabel(job)} onChanged={() => setJobsAsked((n) => n + 1)} />
                ))}
              </ul>
              {jobs.total > JOBS_PAGE_SIZE && (
                <Pagination
                  page={jobsPage}
                  totalPages={Math.ceil(jobs.total / JOBS_PAGE_SIZE)}
                  totalItems={jobs.total}
                  pageSize={JOBS_PAGE_SIZE}
                  onPageChange={setJobsPage}
                />
              )}
            </>
          ))}
      </div>
    </section>
  );
}

/** One job: what it does and to what, its progress over the frozen total, a stop while it runs, and its refused services. */
function JobRow({ job, api, label, onChanged }: { job: BulkJob; api: ReturnType<typeof resellerGrantsApi>; label: string; onChanged: () => void }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();
  const [problems, setProblems] = useState<{ rows: BulkOutcomeRow[]; page: number; purgedAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const action = ACTION_OF[job.action];
  const percent = jobPercent(job);
  const problemCount = job.refused + job.failed;

  async function readProblems(page: number) {
    setBusy(true);
    setError(null);
    try {
      const answer = await api.bulkOutcomes(job.id, page, OUTCOMES_PAGE_SIZE, true);
      setProblems({ rows: answer.rows, page, purgedAt: answer.purgedAt });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(t("common", J.cancelConfirm))) return;
    setBusy(true);
    setError(null);
    try {
      await api.bulkCancel(job.id);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-bold text-text-primary" dir="auto">
          {action ? t("common", G.label[action]) : job.action} · {label}
        </p>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[job.status]}`}>{t("common", J.status[job.status])}</span>
        {job.status === "running" && (
          <button type="button" className={quietButton} disabled={busy} onClick={() => void cancel()}>
            <Square size={12} aria-hidden />
            {t("common", J.cancel)}
          </button>
        )}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-bg-inner"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t("common", J.progress, { processed: job.processed, total: job.total })}
      >
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-text-secondary">
        <span>{t("common", J.progress, { processed: job.processed, total: job.total })}</span>
        <span>{t("common", J.counts, { ok: job.ok, refused: job.refused, failed: job.failed })}</span>
        <span>{formatInstant(job.createdAt, lang)}</span>
      </p>
      {problemCount > 0 && (
        <button type="button" className={quietButton} disabled={busy} onClick={() => (problems ? setProblems(null) : void readProblems(1))}>
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
          {t("common", problems ? J.hideProblems : J.showProblems)}
        </button>
      )}
      {problems && (
        <div className="space-y-1 text-xs">
          {problems.purgedAt ? (
            <p className="text-text-secondary">{t("common", J.purged)}</p>
          ) : problems.rows.length === 0 ? (
            <p className="text-text-secondary">{t("common", J.problemsEmpty)}</p>
          ) : (
            problems.rows.map((o) =>
              o.ok ? null : (
                <p key={o.grantId} className="text-error">
                  {t("common", J.problemLine, { id: o.grantId.slice(0, 8), reason: t("common", bulkRefusalKey(o.reason)) })}
                </p>
              ),
            )
          )}
          {!problems.purgedAt && problemCount > OUTCOMES_PAGE_SIZE && (
            <Pagination
              page={problems.page}
              totalPages={Math.ceil(problemCount / OUTCOMES_PAGE_SIZE)}
              totalItems={problemCount}
              pageSize={OUTCOMES_PAGE_SIZE}
              onPageChange={(page) => void readProblems(page)}
            />
          )}
        </div>
      )}
      {error !== null && <Alert>{message(error)}</Alert>}
    </li>
  );
}
