"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { accessHistoryApi, tenantRolesApi, type AccessHistoryPage, type AccessHistoryItem, type PermissionArea } from "@/lib/auth-api";
import { Alert, Button } from "../../../../../_components/kit";
import { TableSkeleton } from "../../../../../_components/kit/TableSkeleton";
import { AccessActLine } from "../../../../_components/AccessActLine";
import { ACCESS_HISTORY_KEYS as K } from "../../../../_lib/access-history";
import { permissionIndex } from "../../../../_lib/roles";
import { useUserMessage } from "./useUserMessage";

/**
 * A person's access history (AC-1-p), under Permissions on their Profile tab:
 * every change to what they may do — their role, a key given or taken, a group
 * they joined or left or whose access changed, their role's keys, their team
 * seat — with who, when, why, and what it gained and lost them.
 *
 *  - **read only when opened**, and again on `refresh` (a key given here), as
 *    a Grant's history is;
 *  - **hidden on 403**: the history is read by `role.manage` or `audit.read`,
 *    and a seat holding neither has nothing to open.
 */
export function AccessHistory({ id, userId, refresh = 0 }: { id: string; userId: string; refresh?: number }) {
  const { t } = useLocale();
  const message = useUserMessage();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<AccessHistoryPage<AccessHistoryItem> | null>(null);
  const [registry, setRegistry] = useState<PermissionArea[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    Promise.all([accessHistoryApi.ofPerson(id, userId, page), tenantRolesApi.permissions()])
      .then(([p, reg]) => {
        if (!alive) return;
        setAnswer(p);
        setRegistry(reg.areas);
        setError(null);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id, userId, open, page, refresh]);

  const index = useMemo(() => permissionIndex(registry), [registry]);
  const label = (key: string) => index.get(key)?.label ?? key;

  if (error instanceof ApiError && error.status === 403) return null;

  return (
    <section data-testid="access-history" aria-label={t("common", K.title)} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4 md:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-text-primary">{t("common", K.title)}</h3>
          <p className="text-xs text-text-secondary">{t("common", K.hint)}</p>
        </div>
        <Button variant="quiet" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {t("common", open ? K.close : K.open)}
          <ChevronDown size={12} className={open ? "rotate-180" : ""} aria-hidden />
        </Button>
      </div>
      {open && error !== null && <Alert tone="error">{message(error)}</Alert>}
      {open && answer === null && error === null && <TableSkeleton rows={2} columns={2} />}
      {open && answer !== null && (
        <>
          {answer.items.length === 0 ? (
            <p className="text-xs text-text-secondary">{t("common", K.empty)}</p>
          ) : (
            <ol className="divide-y divide-card-border rounded-2xl border border-card-border bg-bg-inner">
              {answer.items.map((row) => (
                <AccessActLine
                  key={row.id}
                  act={row.act}
                  at={row.at}
                  actor={row.actor}
                  reason={row.act?.reason ?? null}
                  given={row.given}
                  taken={row.taken}
                  label={label}
                />
              ))}
            </ol>
          )}
          {(page > 1 || answer.more) && (
            <div className="flex gap-2">
              <Button variant="quiet" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                {t("common", K.newer)}
              </Button>
              <Button variant="quiet" size="sm" disabled={!answer.more} onClick={() => setPage((p) => p + 1)}>
                {t("common", K.older)}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
