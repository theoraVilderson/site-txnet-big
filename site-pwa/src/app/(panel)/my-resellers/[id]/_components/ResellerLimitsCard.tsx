"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Gauge } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { resellerLimitsApi, type ResellerLimitInEffect } from "@/lib/tenant-api";
import { Badge } from "../../../financial/_components/Badge";
import { formatInstant } from "../../../_lib/datetime";
import { Alert } from "../../../catalog/_components/catalog-ui";
import { MY_LIMIT_KEYS as K, MY_QUOTA_KEYS as Q, limitReading } from "../../_lib/limits";
import { useMoney, usePastText } from "./QuotaCards";

/** The limit names the platform owner's page uses, so both sides say the same thing. */
const NAMES = FrontendI18nKeys.common.resellers.limits.keys;

/**
 * The reseller's own limits on its workspace console (F-019-s, ADR-0106):
 * each key, what is used of it and where the limit comes from —
 * `GET /api/tenants/:id/limits` for the path's reseller, as tenant-service
 * answers it. Read-only: a limit is raised by the platform, through a ticket.
 * A quota (F-019-v10) is read from its statement: what is included and used in
 * this period, and apart from it what was sold past and what that cost.
 */
export function ResellerLimitsCard({ tenantId }: { tenantId: string }) {
  const { t, lang } = useLocale();
  const message = useApiErrorMessage();
  const money = useMoney();
  const past = usePastText();
  const [rows, setRows] = useState<ResellerLimitInEffect[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    resellerLimitsApi.ofReseller(tenantId).then(
      (v) => alive && setRows(v),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [tenantId]);

  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-5">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-bold text-text-primary">{t("common", K.title)}</h2>
      </div>
      <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
      {error !== null && <Alert>{message(error)}</Alert>}
      {rows && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map((row) => {
            const st = row.statement ?? null;
            // A quota's bar is what is included and used of it; units sold past it are said apart.
            const r = limitReading(st ? { ...row, used: st.includedUsed } : row);
            const until = row.lockedUntil ? formatInstant(row.lockedUntil, lang, { withTime: false }) : null;
            return (
              <li key={row.key} className="space-y-2 rounded-xl bg-bg-inner p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs text-text-secondary">{t("common", NAMES[row.key].name)}</span>
                  {r.full && <Badge icon={AlertCircle} className="border-gold/20 bg-gold-bg text-gold" label={t("common", K.full)} />}
                </div>
                <div className="text-sm font-bold text-text-primary">{t("common", K[r.text], r.vars)}</div>
                {r.share !== null && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-card-border" aria-hidden>
                    <div className={`h-full rounded-full ${r.full ? "bg-gold" : "bg-primary"}`} style={{ width: `${Math.round(r.share * 100)}%` }} />
                  </div>
                )}
                {st && st.overageQty > 0 && (
                  <div className="text-[11px] text-text-primary">{t("common", Q.extra, { count: st.overageQty, cost: money(st.overageAmount, row.overage?.currencyCode ?? null) })}</div>
                )}
                {st && <div className="text-[11px] text-text-secondary">{t("common", Q.periods[st.period.kind])}</div>}
                {row.overage && <div className="text-[11px] text-text-secondary">{past(row.overage)}</div>}
                {until && <div className="text-[11px] text-text-secondary">{t("common", Q.lockedUntil, { date: until })}</div>}
                <div className="text-[11px] text-text-secondary">{t("common", K.sources[row.source])}</div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-text-secondary">{t("common", K.raise)}</p>
    </section>
  );
}
