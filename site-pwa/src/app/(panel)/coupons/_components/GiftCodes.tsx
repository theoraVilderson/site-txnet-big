"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BarChart3, Download, Gift, Loader2, Plus, Power, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { Me } from "@/lib/auth-api";
import { billingApi, type GiftBatch, type GiftBatchPage } from "@/lib/billing-api";
import { DatePicker } from "../../_components/kit/DatePicker";
import { Pagination } from "../../_components/kit/Pagination";
import { Select } from "../../_components/kit/Select";
import { formatInstant } from "../../_lib/datetime";
import { COUPON_KEYS, refusalKey } from "../_lib/coupon-form";
import { GIFT_KEYS as G, downloadText, emptyGiftBatchForm, giftBatchBody, validateGiftBatch, type GiftBatchErrors, type GiftBatchForm } from "../_lib/gift-batch";
import { variantOwnerTenant } from "../_lib/variant-choices";
import { CouponUsage } from "./CouponUsage";
import { ListSkeleton } from "./ListSkeleton";
import { VariantPicker } from "./VariantPicker";
import { Button, Dialog, Input, Textarea, useConfirm } from "../../_components/kit";
import { isPlatformTenant } from "@/lib/tenant-type";

const PAGE_SIZE = 20;

/**
 * The coupons page, tab 2 — gift codes (F-502-h, D-33): generate a batch, list
 * batches, download a batch as CSV, switch a batch off.
 *
 * **The codes are never on screen.** Generating answers the batch, not its
 * codes; the CSV is fetched on the click, built into a file in the browser and
 * its URL revoked at once. Billing audits the export.
 */
export function GiftCodes({ me, owner }: { me: Me | null; owner: boolean }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const errorMessage = useApiErrorMessage();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<GiftBatchPage | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [usageOf, setUsageOf] = useState<GiftBatch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const message = (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const load = useCallback(async (p: number) => {
    try {
      setData(await billingApi.giftBatches({ page: p, pageSize: PAGE_SIZE }));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Every setState in load runs after its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(page);
  }, [load, page]);

  const act = async (b: GiftBatch, run: () => Promise<void>) => {
    setBusy(b.id);
    setActionError(null);
    try {
      await run();
    } catch (e) {
      setActionError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const download = (b: GiftBatch) =>
    act(b, async () => {
      const { filename, csv } = await billingApi.exportGiftBatch(b.id);
      downloadText(filename, csv);
      setNotice(t("common", G.downloaded));
    });

  const deactivate = async (b: GiftBatch) => {
    if (!(await confirm({ title: t("common", G.confirmDeactivate, { label: b.label }), tone: "danger" }))) return;
    void act(b, async () => {
      const out = await billingApi.deactivateGiftBatch(b.id);
      setNotice(t("common", G.deactivatedNotice, { count: String(out.deactivated) }));
      await load(page);
    });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setCreating(true)} icon={<Plus size={16} aria-hidden />}>
          {t("common", G.add)}
        </Button>
      </div>
      {notice && (
        <p role="status" className="rounded-xl border border-card-border bg-card-bg p-3 text-xs text-text-primary">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs font-bold text-error">
          {actionError}
        </p>
      )}

      {isLoading ? (
        <ListSkeleton label={t("common", G.loading)} />
      ) : (
        <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="alert" className="text-xs font-bold text-error">
                {message(error)}
              </p>
              <Button variant="quiet" size="sm" onClick={() => void load(page)} icon={<RotateCw size={14} aria-hidden />} className="text-primary hover:text-primary">
                {t("common", COUPON_KEYS.retry)}
              </Button>
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="grid size-14 place-items-center rounded-2xl bg-[var(--leaf-bg)] text-primary">
                <Gift size={26} aria-hidden />
              </span>
              <p className="text-sm text-text-secondary">{t("common", G.empty)}</p>
            </div>
          ) : (
            <ul className="divide-y divide-card-border">
              {data.items.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
                      {b.label}
                      <span className={`rounded-full px-2 py-0.5 text-3xs font-bold ${b.deactivatedAt ? "bg-error/10 text-error" : "bg-primary/10 text-primary"}`}>
                        {t("common", b.deactivatedAt ? G.list.deactivated : G.list.live)}
                      </span>
                      {owner && (
                        <span className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-3xs font-bold text-text-secondary">
                          {b.tenantId === null ? t("common", G.list.platform) : t("common", G.list.tenant, { id: b.tenantId.slice(0, 8) })}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {t("common", G.list.usedOf, { used: String(b.used), count: String(b.codes) })}
                      {b.reserved > 0 && ` · ${t("common", G.list.reserved, { count: String(b.reserved) })}`} · {t("common", G.list.created, { date: formatInstant(b.createdAt, lang) ?? "" })}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {busy === b.id && <Loader2 size={14} className="animate-spin text-primary" aria-hidden />}
                    <RowButton icon={BarChart3} label={t("common", G.list.usage)} onClick={() => setUsageOf(b)} />
                    <RowButton icon={Download} label={t("common", G.list.download)} disabled={busy !== null} onClick={() => void download(b)} />
                    {!b.deactivatedAt && <RowButton icon={Power} label={t("common", G.list.deactivate)} tone="error" disabled={busy !== null} onClick={() => deactivate(b)} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data && totalPages > 1 && (
            <div className="mt-4">
              <Pagination page={data.page} totalPages={totalPages} totalItems={data.total} pageSize={data.pageSize} onPageChange={setPage} />
            </div>
          )}
        </section>
      )}

      {creating && (
        <GiftBatchSheet
          me={me}
          onClose={() => setCreating(false)}
          onCreated={async (batch) => {
            setCreating(false);
            setNotice(t("common", G.createdNotice, { count: String(batch.codes), label: batch.label }));
            setPage(1);
            await load(1);
          }}
        />
      )}
      {usageOf && (
        <CouponUsage
          title={t("common", G.usageTitle, { label: usageOf.label })}
          load={(query) => billingApi.giftBatchUsage(usageOf.id, query)}
          onClose={() => setUsageOf(null)}
        />
      )}
    </>
  );
}

function RowButton({ icon: Icon, label, onClick, tone = "primary", disabled }: { icon: typeof Gift; label: string; onClick: () => void; tone?: "primary" | "error"; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold disabled:opacity-50 ${tone === "error" ? "text-error" : "text-primary"}`}>
      <Icon size={14} aria-hidden />
      {label}
    </button>
  );
}

function GiftBatchSheet({ me, onClose, onCreated }: { me: Me | null; onClose: () => void; onCreated: (b: GiftBatch) => void | Promise<void> }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const owner = isPlatformTenant(me?.tenant?.type);
  const [form, setForm] = useState<GiftBatchForm>(emptyGiftBatchForm);
  const [errors, setErrors] = useState<GiftBatchErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const F = G.form;

  const set = <K extends keyof GiftBatchForm>(k: K, v: GiftBatchForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async () => {
    const found = validateGiftBatch(form, me);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      await onCreated(await billingApi.generateGiftBatch(giftBatchBody(form, me)));
    } catch (e) {
      const key = refusalKey(e);
      setFailure(key ? t("common", key) : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const field = (k: keyof GiftBatchForm, label: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`gb-${k}`} className="text-xs font-bold text-text-primary">
        {label}
      </label>
      {control}
      {errors[k] ? (
        <span role="alert" className="text-2xs font-bold text-error">
          {t("common", errors[k]!)}
        </span>
      ) : (
        hint && <span className="text-2xs text-text-secondary">{hint}</span>
      )}
    </div>
  );
  const text = (k: keyof GiftBatchForm, opts: { ltr?: boolean; area?: boolean } = {}) =>
    opts.area ? (
      <Textarea id={`gb-${k}`} dir={opts.ltr ? "ltr" : undefined} rows={3} className="font-mono text-xs" aria-invalid={Boolean(errors[k])} value={form[k]} onChange={(e) => set(k, e.target.value)} />
    ) : (
      <Input id={`gb-${k}`} dir={opts.ltr ? "ltr" : undefined} aria-invalid={Boolean(errors[k])} value={form[k]} onChange={(e) => set(k, e.target.value)} />
    );

  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      title={t("common", F.title)}
      footer={
        <>
          {failure && (
            <p role="alert" className="me-auto text-xs font-bold text-error">
              {failure}
            </p>
          )}
          <Button variant="quiet" onClick={onClose}>
            {t("common", F.cancel)}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            {t("common", saving ? F.submitting : F.submit)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {owner && (
            <div className="grid gap-3 sm:grid-cols-2">
              {field(
                "owner",
                t("common", F.owner),
                <Select
                  id="gb-owner"
                  value={form.owner}
                  onChange={(v) => set("owner", v as GiftBatchForm["owner"])}
                  options={[
                    { value: "own", label: t("common", F.ownerOwn) },
                    { value: "platform", label: t("common", F.ownerPlatform) },
                    { value: "tenant", label: t("common", F.ownerTenant) },
                  ]}
                />,
              )}
              {form.owner === "tenant" && field("tenantId", t("common", F.tenantId), text("tenantId", { ltr: true }))}
            </div>
          )}
          {field("label", t("common", F.label), text("label"))}
          <div className="grid gap-3 sm:grid-cols-2">
            {field("count", t("common", F.count), text("count", { ltr: true }), t("common", F.countHint))}
            {field(
              "kind",
              t("common", F.kind),
              <Select
                id="gb-kind"
                value={form.kind}
                onChange={(v) => set("kind", v as typeof form.kind)}
                options={[
                  { value: "credit", label: t("common", F.kindCredit) },
                  { value: "service", label: t("common", F.kindService) },
                ]}
              />,
            )}
            {form.kind === "service"
              ? field(
                  "grantVariantId",
                  t("common", F.grantVariantId),
                  <VariantPicker
                    id="gb-grantVariantId"
                    value={form.grantVariantId}
                    onChange={(v) => set("grantVariantId", v)}
                    ownerTenant={variantOwnerTenant(form.owner, form.tenantId, me)}
                    invalid={Boolean(errors.grantVariantId)}
                  />,
                  t("common", F.grantVariantHint),
                )
              : field("value", t("common", F.value), text("value", { ltr: true }))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("prefix", t("common", F.prefix), text("prefix", { ltr: true }), t("common", F.prefixHint))}
            {field("expiresAt", t("common", F.expiresAt), <DatePicker value={form.expiresAt} onChange={(v) => set("expiresAt", v ?? "")} />)}
          </div>
          {field("note", t("common", F.note), text("note", { area: true }))}
        </div>
    </Dialog>
  );
}
