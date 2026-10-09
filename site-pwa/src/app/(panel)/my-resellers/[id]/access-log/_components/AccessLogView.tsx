"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { accessHistoryApi, authApi, tenantRolesApi, type AccessAct, type AccessHistoryPage, type PermissionArea } from "@/lib/auth-api";
import { Alert, Button, PageHeader } from "../../../../_components/kit";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { AccessActLine } from "../../../_components/AccessActLine";
import { ConsentNeeded, PlatformAccessBanner } from "../../../_components/PlatformAccessBanner";
import { ACCESS_HISTORY_KEYS as K, actKeysMoved } from "../../../_lib/access-history";
import { permissionIndex } from "../../../_lib/roles";
import { consentRefusal } from "../../../_lib/support-access";
import { useUserMessage } from "../../users/[userId]/_components/useUserMessage";

/**
 * A tenant's access log (AC-1-p): every act that moved what someone may do —
 * a role set on a person, a key given, taken or lifted, a group's access or
 * members, a role's keys, a team seat — newest first, with who, why, and how
 * many people it moved. A role's or a group's edit shows the keys it gave and
 * took (`actKeysMoved`); a person's own history says what it did to them.
 *
 * No permission is judged here: `ResellerAccess` admits by `audit.read`, and
 * its refusal is the page's sentence.
 */
export function AccessLogView({ id }: { id: string }) {
  const { t } = useLocale();
  const message = useUserMessage();
  const [page, setPage] = useState(1);
  const [asked, setAsked] = useState(0);
  const [answer, setAnswer] = useState<AccessHistoryPage<AccessAct & { moved: number }> | null>(null);
  const [registry, setRegistry] = useState<PermissionArea[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([accessHistoryApi.ofTenant(id, page), tenantRolesApi.permissions()])
      .then(([p, reg]) => {
        if (!alive) return;
        setAnswer(p);
        setRegistry(reg.areas);
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
  }, [id, page, asked]);

  // The name for the title, when the visitor owns it; staff see the plain title.
  useEffect(() => {
    let alive = true;
    authApi
      .ownedResellers()
      .then((r) => alive && setSlug(r.resellers.find((x) => x.id === id)?.slug ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  const index = useMemo(() => permissionIndex(registry), [registry]);
  const label = (key: string) => index.get(key)?.label ?? key;
  const reload = () => {
    setLoadError(null);
    setAsked((n) => n + 1);
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader
        title={slug ? t("common", K.logTitleOf, { slug }) : t("common", K.logTitle)}
        subtitle={t("common", K.logSubtitle)}
        actions={
          <Button variant="quiet" size="sm" onClick={reload} icon={<RefreshCw size={12} aria-hidden />}>
            {t("common", K.refresh)}
          </Button>
        }
      />

      <PlatformAccessBanner tenantId={id} onChange={reload} />

      {consentRefusal(loadError) ? (
        <ConsentNeeded error={loadError} />
      ) : loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button variant="primary" size="sm" onClick={reload}>
            {t("common", K.reload)}
          </Button>
        </div>
      ) : answer === null ? (
        <TableSkeleton rows={4} columns={2} />
      ) : answer.items.length === 0 ? (
        <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">{t("common", K.logEmpty)}</p>
      ) : (
        <ol data-testid="access-log" className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card-bg">
          {answer.items.map((act) => {
            const keys = actKeysMoved(act);
            return (
              <AccessActLine key={act.id} act={act} at={act.at} actor={act.actor} reason={act.reason} given={keys.given} taken={keys.taken} label={label} moved={act.moved} />
            );
          })}
        </ol>
      )}

      {answer !== null && (page > 1 || answer.more) && (
        <div className="flex gap-2">
          <Button variant="quiet" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            {t("common", K.newer)}
          </Button>
          <Button variant="quiet" size="sm" disabled={!answer.more} onClick={() => setPage((p) => p + 1)}>
            {t("common", K.older)}
          </Button>
        </div>
      )}
    </div>
  );
}
