"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { tenantTimeZoneApi } from "@/lib/tenant-api";
import { Alert, input, primaryButton, quietButton } from "../catalog/_components/catalog-ui";
import { TableSkeleton } from "./kit/TableSkeleton";
import { ZoneSelect } from "./ZoneSelect";

const Z = FrontendI18nKeys.common.timeZone;

/** The route's refusals (`tenant/contract.time-zone.md`), each with its own sentence. */
type Refusal = keyof typeof Z.tenant.refusals;
const refusalOf = (e: unknown): Refusal | null => {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in Z.tenant.refusals ? (reason as Refusal) : null;
};

/**
 * A tenant's time zone, read and set (TZ-1-e over TZ-1-d,
 * `tenant/contract.time-zone.md`). `scope` says whose: a reseller's, from its
 * workspace, or the platform's own, from `/settings`. It moves no instant —
 * only which wall clock the tenant's reports and its zone-less users read.
 */
export function TenantTimeZoneCard({ tenantId, scope }: { tenantId: string; scope: "reseller" | "platform" }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const refusal = refusalOf(e);
    return refusal ? t("common", Z.tenant.refusals[refusal]) : errorMessage(e);
  };

  const [zone, setZone] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    tenantTimeZoneApi
      .get(tenantId)
      .then((v) => {
        if (!alive) return;
        setZone(v.timezone);
        setPicked(v.timezone);
      })
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [tenantId, asked]);

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await tenantTimeZoneApi.set(tenantId, picked);
      setZone(answer.timezone);
      setPicked(answer.timezone);
      setSaved(true);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-3xl border border-card-border bg-card-bg p-6">
      <h2 className="mb-1 text-lg font-bold text-text-primary">{t("common", Z.tenant.title)}</h2>
      <p className="mb-5 text-sm text-text-secondary">{t("common", scope === "platform" ? Z.tenant.hintPlatform : Z.tenant.hint)}</p>

      {loadError !== null ? (
        <div className="space-y-3">
          <Alert>{message(loadError)}</Alert>
          <button type="button" className={quietButton} onClick={() => setAsked((n) => n + 1)}>
            {t("common", Z.reload)}
          </button>
        </div>
      ) : zone === null ? (
        <TableSkeleton rows={1} columns={2} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1">
              <span className="mb-1 block text-sm text-text-secondary">{t("common", Z.label)}</span>
              <ZoneSelect
                className={input}
                value={picked}
                disabled={busy}
                onChange={(next) => {
                  setPicked(next);
                  setFailure(null);
                  setSaved(false);
                }}
              />
            </label>
            <button type="button" className={primaryButton} disabled={busy || !picked || picked === zone} onClick={submit}>
              {t("common", Z.save)}
            </button>
          </div>
          {failure !== null && <Alert>{message(failure)}</Alert>}
          {saved && <p className="text-sm font-medium text-primary">{t("common", Z.tenant.saved)}</p>}
        </div>
      )}
    </section>
  );
}
