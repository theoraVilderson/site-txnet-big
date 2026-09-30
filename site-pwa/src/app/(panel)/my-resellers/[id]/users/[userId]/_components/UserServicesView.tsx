"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Copy, Loader2, QrCode, RefreshCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { resellerUserGrantsApi, type GrantRow, type GrantScope, type ResellerUserGrantsApi, type UserConfigRow } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { myResellerUsersPath } from "@/lib/routes";
import { Pagination } from "../../../../../_components/kit/Pagination";
import { TableSkeleton } from "../../../../../_components/kit/TableSkeleton";
import { copyText } from "../../../../../_lib/clipboard";
import { formatInstant } from "../../../../../_lib/datetime";
import { Alert, primaryButton, quietButton } from "../../../../../catalog/_components/catalog-ui";
import { flattenTexts } from "../../../../../catalog/_lib/catalog-form";
import { ConfigLines } from "../../../../../services/_components/ConfigLines";
import { QrDialog } from "../../../../../services/_components/QrDialog";
import { UsageBars } from "../../../../../services/_components/UsageBars";
import { UsageMeter } from "../../../../../services/_components/UsageMeter";
import { GRANT_TONES, serviceName } from "../../../../../services/_lib/my-services";
import { USER_KEYS as K } from "../../../../_lib/users";
import { UserGrantLimitCard } from "../../../../_components/GrantLimitCards";
import { AdminConfigs } from "./AdminConfigs";
import { GrantActions, IssueGrant } from "./GrantActions";
import { GrantHistory } from "./GrantHistory";
import { useUserMessage } from "./useUserMessage";

const S = K.services;
const PAGE_SIZE = 20;

/**
 * One user's services, as the admin of the reseller the **path** names reads
 * them (F-311-v, `panel-web/contract.reseller-users.md`) — billing's
 * `/tenants/:id/users/:userId/…` (F-311-f/g), never the session's tenant and
 * never the admin's own Grants.
 *
 *  - **what the user sees, from the same pieces**: the meter, the 30 days,
 *    the lines with copy and QR, and the subscription link — `/services`'
 *    own components, asked through this user's routes;
 *  - **a sheet is read when it is opened**: expanding one Grant asks three
 *    routes against one bucket (300/900s), so ten closed rows ask nothing;
 *  - **no rename**: the admin surface has no label route, so no pencil;
 *  - **a Grant's acts sit on its sheet, the issue of a new one on the page**
 *    (F-311-w, `GrantActions.tsx`); after either the list is read again;
 *  - **a suspended reseller reads and cannot act**: the actions come back
 *    `reseller_suspended`, said as its sentence.
 */
export function UserServicesView({ id, userId }: { id: string; userId: string }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();
  const name = useSearchParams().get("name");
  const [texts, setTexts] = useState<Record<string, string>>({});
  const api = useMemo(() => resellerUserGrantsApi(id, userId), [id, userId]);

  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<GrantScope>("current");
  const [answer, setAnswer] = useState<{ rows: GrantRow[]; total: number; hidden: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .grants(page, PAGE_SIZE, scope)
      .then((p) => {
        if (!alive) return;
        setAnswer({ rows: p.rows, total: p.total, hidden: p.hidden });
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setAnswer(null);
        setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [api, page, scope, asked]);

  // A reseller's items are named in the same published `catalog` namespace
  // as the platform's; a failed read leaves the SKU, as on `/services`.
  useEffect(() => {
    let alive = true;
    catalogApi
      .texts(lang)
      .then(flattenTexts)
      .catch(() => ({}))
      .then((flat) => alive && setTexts(flat));
    return () => {
      alive = false;
    };
  }, [lang]);

  const retry = () => {
    setLoadError(null);
    setAsked((n) => n + 1);
  };
  const toggleScope = () => {
    setScope((s) => (s === "current" ? "all" : "current"));
    setPage(1);
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <Link href={myResellerUsersPath(id)} className={`${quietButton} mb-2 -ms-2`}>
            <ArrowRight size={12} className="ltr:rotate-180" aria-hidden />
            {t("common", S.back)}
          </Link>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">
            {name ? t("common", S.title, { name }) : t("common", S.titlePlain)}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", S.subtitle)}</p>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <button type="button" className={quietButton} onClick={retry}>
            <RefreshCw size={12} aria-hidden />
            {t("common", K.refresh)}
          </button>
          <IssueGrant api={api} tenantId={id} texts={texts} onIssued={retry} />
        </div>
      </header>

      {/* Read again with the list: an issue or a refresh changes how many are open. */}
      <UserGrantLimitCard key={asked} tenantId={id} userId={userId} />

      {loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert>{message(loadError)}</Alert>
          <button type="button" className={primaryButton} onClick={retry}>
            {t("common", K.reload)}
          </button>
        </div>
      ) : answer === null ? (
        <TableSkeleton rows={3} columns={2} />
      ) : (
        <>
          {answer.rows.length === 0 ? (
            <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">
              {t("common", scope === "current" && answer.hidden > 0 ? S.noCurrent : S.empty)}
            </p>
          ) : (
            <ul className="space-y-3">
              {answer.rows.map((row) => (
                <AdminGrantCard key={row.id} api={api} row={row} texts={texts} onChanged={retry} />
              ))}
            </ul>
          )}
          {(answer.hidden > 0 || scope === "all") && (
            <button type="button" className={quietButton} onClick={toggleScope}>
              {scope === "current" ? t("common", S.showEnded, { count: answer.hidden }) : t("common", S.hideEnded)}
            </button>
          )}
          <Pagination
            page={page}
            totalPages={Math.max(1, Math.ceil(answer.total / PAGE_SIZE))}
            totalItems={answer.total}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}

/** One Grant: its name, status and meter; opened, its sheet. */
function AdminGrantCard({ api, row, texts, onChanged }: { api: ResellerUserGrantsApi; row: GrantRow; texts: Record<string, string>; onChanged: () => void }) {
  const { t, lang } = useLocale();
  const [open, setOpen] = useState(false);
  const tone = GRANT_TONES[row.status];
  const Icon = tone.icon;
  const name = serviceName(texts, row) ?? t("common", S.noPlan);

  return (
    <li className="rounded-2xl border border-card-border bg-card-bg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-base font-bold text-text-primary" dir="auto">
          {name}
        </p>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tone.className}`}>
          <Icon size={12} aria-hidden />
          {t("common", tone.labelKey)}
        </span>
        <button type="button" aria-expanded={open} className={quietButton} onClick={() => setOpen((o) => !o)}>
          {t("common", open ? S.close : S.details)}
          <ChevronDown size={12} className={open ? "rotate-180" : ""} aria-hidden />
        </button>
      </div>
      <p className="mt-1 text-xs text-text-secondary">
        {row.endsAt ? t("common", S.ends, { date: formatInstant(row.endsAt, lang, { withTime: false }) ?? "" }) : t("common", S.permanent)}
      </p>
      <div className="mt-3">
        <UsageMeter row={row} live={false} warn={false} />
      </div>
      {open && <GrantSheet api={api} row={row} onChanged={onChanged} />}
    </li>
  );
}

/** An opened Grant: its acts and their history, the 30 days, the subscription link, the configs and their lines. */
function GrantSheet({ api, row, onChanged }: { api: ResellerUserGrantsApi; row: GrantRow; onChanged: () => void }) {
  const grantId = row.id;
  const message = useUserMessage();
  const [rows, setRows] = useState<UserConfigRow[] | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .grantConfigs(grantId)
      .then((answer) => {
        if (!alive) return;
        setRows(answer.rows);
        setReadError(null);
      })
      .catch((e) => alive && setReadError(e));
    return () => {
      alive = false;
    };
  }, [api, grantId, asked]);

  const reload = () => setAsked((n) => n + 1);
  // A Grant's act can switch its configs off or on, or release them: both reads.
  const acted = () => {
    reload();
    onChanged();
  };

  return (
    <div className="mt-4 space-y-4 border-t border-card-border pt-4">
      <GrantActions api={api} row={row} onActed={acted} />
      <GrantHistory api={api} grantId={grantId} refresh={asked} />
      <UsageBars grantId={grantId} read={api.grantUsage} />
      {/* Re-mounted by every read, so a link read before a rotate is not kept. */}
      <SubscriptionLink key={asked} api={api} grantId={grantId} />
      {readError !== null && <Alert>{message(readError)}</Alert>}
      {rows === null && readError === null && <TableSkeleton rows={2} columns={2} />}
      {rows !== null && (
        <>
          <AdminConfigs api={api} rows={rows} onActed={reload} />
          {rows.length > 0 && <ConfigLines rows={rows} />}
        </>
      )}
    </div>
  );
}

/** The Grant's `/sub` link: read when a copy or the QR asks for it, never held past the page. */
function SubscriptionLink({ api, grantId }: { api: ResellerUserGrantsApi; grantId: string }) {
  const { t } = useLocale();
  const message = useUserMessage();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function read(): Promise<string | null> {
    if (link) return link;
    setBusy(true);
    setError(null);
    try {
      const { subscriptionUrl } = await api.subscriptionLink(grantId);
      setLink(subscriptionUrl);
      return subscriptionUrl;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    const url = await read();
    if (url && (await copyText(url))) setCopied(true);
  }

  return (
    <div className="rounded-2xl border border-card-border bg-bg-inner p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-bold text-text-primary">{t("common", S.subscription)}</p>
        {busy && <Loader2 size={14} className="animate-spin text-text-secondary" aria-hidden />}
        <button type="button" className={quietButton} disabled={busy} onClick={() => void copy()}>
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          {t("common", copied ? S.subscriptionCopied : S.subscriptionCopy)}
        </button>
        <button type="button" className={quietButton} disabled={busy} onClick={() => void read().then((url) => url && setQr(true))}>
          <QrCode size={12} aria-hidden />
          {t("common", S.subscriptionQr)}
        </button>
      </div>
      {link && (
        <p className="mt-2 break-all font-mono text-[11px] text-text-secondary" dir="ltr">
          {link}
        </p>
      )}
      {error !== null && (
        <div className="mt-2">
          <Alert>{message(error)}</Alert>
        </div>
      )}
      {qr && link && (
        <QrDialog
          title={t("common", S.subscription)}
          value={link}
          label={t("common", S.subscription)}
          copied={copied}
          onCopy={() => void copy()}
          onClose={() => setQr(false)}
        />
      )}
    </div>
  );
}
