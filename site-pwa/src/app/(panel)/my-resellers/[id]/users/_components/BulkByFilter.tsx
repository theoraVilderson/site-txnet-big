"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { resellerGrantsApi, type BulkJob, type BulkPanel } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { Pagination } from "../../../../_components/kit/Pagination";
import { flattenTexts } from "../../../../catalog/_lib/catalog-form";
import { GRANT_KEYS as G, emptyDraft, type GrantActionDraft } from "../../../_lib/grant-actions";
import { BULK_ACTIONS, JOB_KEYS as J, JOB_POLL_MS, bulkJobBody, filterOf, type BulkAction, type BulkScope } from "../../../_lib/grant-bulk";
import { USER_KEYS } from "../../../_lib/users";
import { ActionFields } from "../[userId]/_components/GrantActions";
import { useUserMessage } from "../[userId]/_components/useUserMessage";
import { Alert, Button, Field, Input, NativeSelect } from "../../../../_components/kit";
import { JobRow } from "./BulkJobRow";

const JOBS_PAGE_SIZE = 10;
/** billing's `GRANT_BULK_JOB_MAX_GRANTS`: past it the start is refused, so the confirm says so first. */
const MAX_JOB_GRANTS = 100_000;
const panel = "space-y-2 rounded-2xl border border-card-border bg-bg-inner p-3";

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
    // The users-admin door's list (F-311-ab2, D-57): no `catalog.manage`, the platform's too.
    Promise.all([api.usersCatalog(), catalogApi.texts(lang).then(flattenTexts).catch(() => ({}) as Record<string, string>)])
      .then(([list, texts]) =>
        // Every product and plan: a service sold before one was switched off is still its.
        list.map((p) => ({
          id: p.id,
          label: texts[p.nameKey] || p.variants[0]?.sku || p.id.slice(0, 8),
          variants: p.variants.map((v) => ({ id: v.id, label: texts[v.nameKey ?? p.nameKey] ? `${texts[v.nameKey ?? p.nameKey]} · ${v.sku}` : v.sku })),
        })),
      )
      .then((ps) => alive && setProducts(ps))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [api, kind, lang, products]);

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
          <Button size="sm" key={action} disabled={busy} aria-pressed={open === action} onClick={() => start(action)}>
            {t("common", G.label[action])}
          </Button>
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
              <NativeSelect value={panelId} aria-label={t("common", J.panelPick)} onChange={(e) => setPanelId(e.target.value)}>
                <option value="">{t("common", J.panelPick)}</option>
                {panels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t("common", J.panelOption, { name: p.name, region: p.region, count: p.grants })}
                    {p.own ? ` · ${t("common", J.own)}` : ""}
                    {p.retired ? ` · ${t("common", J.retired)}` : ""}
                  </option>
                ))}
              </NativeSelect>
            ))}

          {kind === "product" &&
            (products === null ? (
              <p className="text-xs text-text-secondary">{t("common", J.loading)}</p>
            ) : products.length === 0 ? (
              <p className="text-xs text-text-secondary">{t("common", J.noProducts)}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <NativeSelect
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
                </NativeSelect>
                {product && product.variants.length > 1 && (
                  <NativeSelect value={variantId} aria-label={t("common", J.variantAll)} onChange={(e) => setVariantId(e.target.value)}>
                    <option value="">{t("common", J.variantAll)}</option>
                    {product.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </NativeSelect>
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
          <Field label={t("common", G.field.reason)}>
            <Input
              className="mt-1"
              value={draft.reason}
              maxLength={500}
              placeholder={t("common", G.field.reasonPlaceholder)}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </Field>
          {body !== null && <p className="text-xs text-text-secondary">{t("common", J.confirm, { count: count ?? 0 })}</p>}
          <div className="flex gap-2">
            <Button variant="primary" size="sm" type="submit" disabled={body === null} loading={busy}>
              {t("common", J.submit, { count: count ?? 0 })}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setOpen(null)}>
              {t("common", USER_KEYS.actions.cancel)}
            </Button>
          </div>
        </form>
      )}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}

      <div className="space-y-2">
        <p className="text-xs font-bold text-text-secondary">{t("common", J.jobsTitle)}</p>
        {jobsError !== null && <Alert tone="error">{message(jobsError)}</Alert>}
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
