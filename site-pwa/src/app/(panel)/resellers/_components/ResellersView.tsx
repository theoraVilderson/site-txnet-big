"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Gauge, Package, Plus, RotateCw, Store } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { tenantApi, type Reseller } from "@/lib/tenant-api";
import { PANEL_RESELLER_LIMITS, PANEL_RESELLER_PACKAGES, panelResellerPath } from "@/lib/routes";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { DataTable } from "../../_components/kit/DataTable";
import { Alert, StatusBadge, primaryButton, quietButton, useMessage } from "./resellers-ui";
import { RESELLER_KEYS as K, canAdministerResellers } from "../_lib/resellers";
import { CreateResellerSheet } from "./CreateResellerSheet";

const PAGE_SIZE = 20;

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
 * A row opens the reseller's own page (F-019-k) — a link, not a sheet, so it
 * can be sent to someone and reloaded on the tab it was left on.
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
        <div className="flex flex-wrap items-center gap-2">
          <Link href={PANEL_RESELLER_PACKAGES} className={quietButton}>
            <Package size={14} aria-hidden />
            {t("common", K.packages.link)}
          </Link>
          <Link href={PANEL_RESELLER_LIMITS} className={quietButton}>
            <Gauge size={14} aria-hidden />
            {t("common", K.limits.link)}
          </Link>
          <button type="button" className={primaryButton} onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden />
            {t("common", K.new)}
          </button>
        </div>
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
        <DataTable
          label={t("common", K.title)}
          rows={rows}
          rowKey={(r) => r.id}
          minWidth="min-w-[720px]"
          columns={[
            {
              id: "slug",
              header: t("common", K.columns.slug),
              cell: (r) => (
                <Link href={panelResellerPath(r.id)} className="font-bold text-primary hover:underline" dir="ltr">
                  {r.slug}
                </Link>
              ),
            },
            { id: "owner", header: t("common", K.columns.owner), cell: (r) => r.owner?.fullName || r.owner?.username || "—", className: "text-text-secondary" },
            { id: "status", header: t("common", K.columns.status), cell: (r) => <StatusBadge status={r.status} /> },
            { id: "period", header: t("common", K.columns.period), cell: (r) => t("common", K.period[r.billingModel]), className: "text-text-secondary" },
            { id: "balance", header: t("common", K.columns.balance), cell: (r) => formatMoney(r.billingBalance, r.billingCurrencyCode, { lang, t }), dir: "ltr" },
            { id: "created", header: t("common", K.columns.created), cell: (r) => formatInstant(r.createdAt, lang, { withTime: false }), className: "text-text-secondary" },
          ]}
        />
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
    </div>
  );
}
