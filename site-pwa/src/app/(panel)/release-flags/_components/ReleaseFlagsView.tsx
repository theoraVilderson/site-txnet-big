"use client";

import { useCallback, useEffect, useState } from "react";
import { Flag, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { releaseFlagsApi, type ReleaseFlagRow } from "@/lib/release-flags-api";
import { tenantApi, type Reseller } from "@/lib/tenant-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Alert, Button, EmptyState, PageHeader } from "../../_components/kit";
import { FLAG_KEYS as K, canSwitchReleaseFlags } from "../_lib/release-flags";
import { FlagCard } from "./FlagCard";

/** How many resellers the exception picker lists, as the limits page does. */
const RESELLER_PAGE = 100;

/**
 * The platform's release flags (OPS-1-ag, `tenant/contract.release-flags.md`):
 * every declared flag, its stage and the resellers with their own answer.
 *
 * Every state shown is tenant-service's answer, read again after each save;
 * nothing here decides who has a flag. Who may switch is tenant-service's to
 * decide; the check here only spares a visitor who typed the path.
 */
export function ReleaseFlagsView() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const allowed = canSwitchReleaseFlags(me);

  const [flags, setFlags] = useState<ReleaseFlagRow[] | null>(null);
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    Promise.all([releaseFlagsApi.table(), tenantApi.resellers(RESELLER_PAGE, 0)]).then(
      ([table, list]) => {
        if (!alive) return;
        setFlags(table);
        setResellers(list);
        setError(null);
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [allowed, asked]);

  const header = (
    <PageHeader
      title={t("common", K.title)}
      subtitle={t("common", K.subtitle)}
      icon={Flag}
      actions={allowed && <Button size="sm" variant="quiet" icon={<RotateCw size={16} aria-hidden />} onClick={reload}>{t("common", K.reload)}</Button>}
    />
  );

  if (sessionLoading) return header;
  if (!allowed) {
    return (
      <>
        {header}
        <Alert tone="warning">{t("common", K.notAllowed)}</Alert>
      </>
    );
  }
  return (
    <>
      {header}
      {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}
      {flags === null && error === null && <TableSkeleton rows={2} columns={3} withPagination={false} />}
      {flags?.length === 0 && <EmptyState icon={Flag} title={t("common", K.emptyTitle)} body={t("common", K.emptyBody)} />}
      <div className="flex flex-col gap-4">
        {flags?.map((flag) => <FlagCard key={flag.key} flag={flag} resellers={resellers} onSaved={reload} />)}
      </div>
    </>
  );
}
