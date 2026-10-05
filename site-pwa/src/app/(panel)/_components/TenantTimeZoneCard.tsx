"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { tenantTimeZoneApi } from "@/lib/tenant-api";
import { TableSkeleton } from "./kit/TableSkeleton";
import { ZoneSelect } from "./ZoneSelect";
import { Alert, Button, Card, CardHeader, Field, notify } from "./kit";

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
      // "Saved" is a toast, never a line that stays (contract.ux.md K11).
      notify.success(t("common", Z.tenant.saved));
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="lg" className="mt-6">
      <CardHeader title={t("common", Z.tenant.title)} subtitle={t("common", scope === "platform" ? Z.tenant.hintPlatform : Z.tenant.hint)} />

      {loadError !== null ? (
        <div className="space-y-3">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button variant="quiet" size="sm" onClick={() => setAsked((n) => n + 1)}>
            {t("common", Z.reload)}
          </Button>
        </div>
      ) : zone === null ? (
        <TableSkeleton rows={1} columns={2} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label={t("common", Z.label)} className="flex-1">
              <ZoneSelect
                value={picked}
                disabled={busy}
                onChange={(next) => {
                  setPicked(next);
                  setFailure(null);
                }}
              />
            </Field>
            <Button variant="primary" loading={busy} disabled={!picked || picked === zone} onClick={submit}>
              {t("common", Z.save)}
            </Button>
          </div>
          {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
        </div>
      )}
    </Card>
  );
}
