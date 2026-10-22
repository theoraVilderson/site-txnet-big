"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, Download } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { RealtimeEvents } from "@/generated/wire";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useLiveReread } from "@/hooks/useLiveReread";
import { userChannel } from "@/lib/realtime";
import { tenantDataExportApi, type DataExportList, type DataExportView } from "@/lib/tenant-data-export-api";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatInstant } from "../../../_lib/datetime";
import { downloadUrl } from "../../../_lib/download";
import { formatBytes } from "../../../services/_lib/service-configs";
import { Alert, Button, StatusPill, notify } from "../../../_components/kit";
import { DATA_EXPORT_KEYS as K, STATUS_TONE, dataExportRefusalKey, msUntilNext } from "../../_lib/data-export";

const LIVE_EVENTS = [RealtimeEvents.tenantDataExportChanged];

/**
 * «Export my data» (F-212-c; tenant `contract.data-export.md`, catalog
 * §14.8): ask for one archive of everything the reseller owns, watch it
 * build, download it — on the path's reseller, in any status.
 *
 *  - **who may is the service's** (`ResellerAccess`): the owner and platform
 *    staff. A `not_allowed` list means a staff seat, and the card is not drawn;
 *  - **the 24 h clock is the service's** `nextAllowedAt`, never counted here —
 *    one read at that instant re-enables the button;
 *  - **a link is minted on the click** — each is audited and lives five minutes;
 *  - **live on the requester's `user:` channel** (C-14): the drain's build,
 *    failure or expiry re-reads the list; only this reseller's events count.
 */
export function DataExportCard({ tenantId }: { tenantId: string }) {
  const { t, lang } = useLocale();
  const { me } = usePanelSession();
  const errorMessage = useApiErrorMessage();
  const [answer, setAnswer] = useState<DataExportList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    tenantDataExportApi.list(tenantId).then(
      (next) => {
        setAnswer(next);
        setError(null);
      },
      (e: unknown) => {
        if ((e as { reason?: unknown } | null)?.reason === "not_allowed") setHidden(true);
        else setError(e);
      },
    );
  }, [tenantId]);
  useEffect(load, [load]);
  useLiveReread(me ? userChannel(me.userId) : null, LIVE_EVENTS, load, (p) => p.resellerId === tenantId);
  // One read at the instant the 24 h clock opens: the service then answers `nextAllowedAt: null`.
  const nextAllowedAt = answer?.nextAllowedAt ?? null;
  useEffect(() => {
    const wait = msUntilNext(nextAllowedAt, Date.now());
    if (wait === null) return;
    const timer = setTimeout(load, wait);
    return () => clearTimeout(timer);
  }, [nextAllowedAt, load]);

  if (hidden) return null;

  const message = (e: unknown) => {
    const key = dataExportRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
  const act = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const request = () =>
    act("request", async () => {
      await tenantDataExportApi.request(tenantId);
      notify.success(t("common", K.queued));
      load();
    });
  const download = (exportId: string) =>
    act(exportId, async () => {
      const link = await tenantDataExportApi.link(tenantId, exportId);
      downloadUrl(link.url);
    });

  const when = (iso: string | null) => formatInstant(iso, lang) ?? "";
  const open = answer !== null && answer.nextAllowedAt === null;

  return (
    <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-5">
      <div className="flex items-center gap-2">
        <Archive className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-bold text-text-primary">{t("common", K.title)}</h2>
      </div>
      <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
      <p className="text-2xs text-text-secondary">{t("common", K.format)}</p>
      {error !== null && <Alert tone="error">{message(error)}</Alert>}

      {!answer ? (
        error === null && <p className="text-xs text-text-secondary">{t("common", K.loading)}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="sm" disabled={!open || busy !== null} onClick={() => void request()}>
              {t("common", K.request)}
            </Button>
            {answer.nextAllowedAt && <span className="text-2xs text-text-secondary">{t("common", K.nextAt, { date: when(answer.nextAllowedAt) })}</span>}
          </div>
          {answer.exports.length === 0 ? (
            <p className="text-xs text-text-secondary">{t("common", K.none)}</p>
          ) : (
            <ul className="space-y-1">
              {answer.exports.map((x) => (
                <ExportLine key={x.id} item={x} when={when} busy={busy === x.id} onDownload={() => void download(x.id)} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** One export: when it was asked for, its state, and — while `ready` — its size, its last day and the download. */
function ExportLine({ item, when, busy, onDownload }: { item: DataExportView; when: (iso: string | null) => string; busy: boolean; onDownload: () => void }) {
  const { t, lang } = useLocale();
  const size = formatBytes(item.sizeBytes === null ? null : String(item.sizeBytes), lang);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-inner px-3 py-2 text-xs">
      <span className="space-y-0.5">
        <span className="block text-text-primary">{t("common", K.asked, { date: when(item.createdAt) })}</span>
        {item.status === "ready" && (
          <span className="block text-2xs text-text-secondary">
            {size !== null && item.rowCount !== null && `${t("common", K.size, { size, rows: item.rowCount })} · `}
            {t("common", K.until, { date: when(item.expiresAt) })}
          </span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <StatusPill tone={STATUS_TONE[item.status]}>{t("common", K.status[item.status])}</StatusPill>
        {item.status === "ready" && (
          <Button variant="quiet" size="sm" disabled={busy} onClick={onDownload}>
            <Download size={14} aria-hidden />
            {t("common", K.download)}
          </Button>
        )}
      </span>
    </li>
  );
}
