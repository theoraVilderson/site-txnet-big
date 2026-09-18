"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle2, Clock, Plus, RotateCw, Store, XCircle, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { tenantApi, type Reseller, type TenantStatus } from "@/lib/tenant-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { BASE_CURRENCY, formatMoney } from "../../_lib/money";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Badge } from "../../financial/_components/Badge";
import { Alert, primaryButton, quietButton, useMessage } from "./resellers-ui";
import { RESELLER_KEYS as K, canAdministerResellers } from "../_lib/resellers";
import { CreateResellerSheet } from "./CreateResellerSheet";
import { ResellerSheet } from "./ResellerSheet";

const PAGE_SIZE = 20;

const STATUS_TONE: Record<TenantStatus, { icon: LucideIcon; className: string }> = {
  trial: { icon: Clock, className: "border-gold/20 bg-gold-bg text-gold" },
  active: { icon: CheckCircle2, className: "border-primary/20 bg-leaf-bg text-primary" },
  suspended: { icon: AlertCircle, className: "border-gold/20 bg-gold-bg text-gold" },
  terminated: { icon: XCircle, className: "border-error-border bg-error-bg text-error" },
};

export function StatusBadge({ status }: { status: TenantStatus }) {
  const { t } = useLocale();
  return <Badge {...STATUS_TONE[status]} label={t("common", K.status[status])} />;
}

/** `?page=` as a positive whole number; anything else is the first page. */
function pageOf(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * The platform owner's resellers (F-018-k), newest first. The route answers a
 * page with no total, so paging is newer/older: "older" exists while a page
 * comes back full. The page number is in the URL, as on `/financial`.
 *
 * Who may see it is tenant-service's to decide; the check here only spares a
 * reseller who typed the path a refused read.
 */
export function ResellersView() {
  const { lang, t } = useLocale();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const message = useMessage();
  const router = useRouter();
  const pathname = usePathname();
  const page = pageOf(useSearchParams().get("page"));
  const allowed = canAdministerResellers(me);

  const [rows, setRows] = useState<Reseller[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const key = `${page}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const isLoading = loaded !== key;

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    (async () => {
      try {
        const answer = await tenantApi.resellers(PAGE_SIZE, (page - 1) * PAGE_SIZE);
        if (!alive) return;
        setRows(answer);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setRows(null);
        setError(e);
      } finally {
        if (alive) setLoaded(key);
      }
    })();
    return () => {
      alive = false;
    };
  }, [allowed, page, key]);

  const go = (next: number) => router.push(next > 1 ? `${pathname}?page=${next}` : pathname, { scroll: false });

  if (sessionLoading) return null;
  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 md:p-8">
        <Alert>{t("common", K.refusals.not_platform_owner)}</Alert>
      </div>
    );
  }

  const cell = "px-3 py-2 text-start";
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
            <Store size={22} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <button type="button" className={primaryButton} onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden />
          {t("common", K.new)}
        </button>
      </header>

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}

      {isLoading ? (
        <TableSkeleton rows={5} columns={6} />
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-card-border bg-card-bg">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-[11px] text-text-secondary">
              <tr>
                <th className={cell}>{t("common", K.columns.slug)}</th>
                <th className={cell}>{t("common", K.columns.owner)}</th>
                <th className={cell}>{t("common", K.columns.status)}</th>
                <th className={cell}>{t("common", K.columns.period)}</th>
                <th className={cell}>{t("common", K.columns.balance)}</th>
                <th className={cell}>{t("common", K.columns.created)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-t border-card-border hover:bg-bg-inner"
                  onClick={() => setOpenId(r.id)}
                >
                  <td className={cell}>
                    <button type="button" className="font-bold text-text-primary" dir="ltr" onClick={() => setOpenId(r.id)}>
                      {r.slug}
                    </button>
                  </td>
                  <td className={`${cell} text-text-secondary`}>{r.owner?.fullName || r.owner?.username || "—"}</td>
                  <td className={cell}>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className={`${cell} text-text-secondary`}>{t("common", K.period[r.billingModel])}</td>
                  <td className={cell} dir="ltr">
                    {formatMoney(r.billingBalance, BASE_CURRENCY, { lang, t })}
                  </td>
                  <td className={`${cell} text-text-secondary`}>{formatInstant(r.createdAt, lang, { withTime: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && !error && (page > 1 || rows?.length === PAGE_SIZE) && (
        <nav className="flex justify-between">
          <button type="button" className={quietButton} disabled={page <= 1} onClick={() => go(page - 1)}>
            {t("common", K.prev)}
          </button>
          <button type="button" className={quietButton} disabled={rows?.length !== PAGE_SIZE} onClick={() => go(page + 1)}>
            {t("common", K.next)}
          </button>
        </nav>
      )}

      {creating && (
        <CreateResellerSheet
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setNotice(t("common", K.create.done, { slug: r.slug }));
            if (page > 1) go(1);
            else reload();
          }}
        />
      )}
      {openId && <ResellerSheet id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
