"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { GrantHistoryRow, ResellerUserGrantsApi } from "@/lib/billing-api";
import { Pagination } from "../../../../../_components/kit/Pagination";
import { TableSkeleton } from "../../../../../_components/kit/TableSkeleton";
import { formatInstant } from "../../../../../_lib/datetime";
import { Alert, quietButton } from "../../../../../catalog/_components/catalog-ui";
import { HISTORY_KEYS as H, historyActionKey } from "../../../../_lib/grant-bulk";
import { useUserMessage } from "./useUserMessage";

const PAGE_SIZE = 20;

/**
 * A Grant's history (F-311-x over F-311-r): every audited admin act on it and
 * on any config it ever held, newest first — who, when, what and why.
 *
 *  - **read only when opened**, and again after an act (`refresh`), so a
 *    closed sheet asks nothing;
 *  - **no IP** — billing does not answer one to the reseller;
 *  - the actor is an id: the panel has no read of another admin by id, so it
 *    is shown short, enough to tell two admins apart.
 */
export function GrantHistory({ api, grantId, refresh }: { api: ResellerUserGrantsApi; grantId: string; refresh: number }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<{ rows: GrantHistoryRow[]; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .history(grantId, page, PAGE_SIZE)
      .then((p) => {
        if (!alive) return;
        setAnswer({ rows: p.rows, total: p.total });
        setError(null);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [api, grantId, open, page, refresh]);

  return (
    <section aria-label={t("common", H.title)} className="space-y-2">
      <button type="button" aria-expanded={open} className={quietButton} onClick={() => setOpen((o) => !o)}>
        {t("common", open ? H.close : H.open)}
        <ChevronDown size={12} className={open ? "rotate-180" : ""} aria-hidden />
      </button>
      {open && error !== null && <Alert>{message(error)}</Alert>}
      {open && answer === null && error === null && <TableSkeleton rows={2} columns={2} />}
      {open && answer !== null && (
        <>
          {answer.rows.length === 0 ? (
            <p className="text-xs text-text-secondary">{t("common", H.empty)}</p>
          ) : (
            <ol className="divide-y divide-card-border rounded-2xl border border-card-border bg-bg-inner">
              {answer.rows.map((row) => (
                <li key={row.id} className="space-y-0.5 px-3 py-2 text-xs">
                  <p className="flex flex-wrap items-center gap-x-2 font-bold text-text-primary">
                    {t("common", historyActionKey(row.action))}
                    {row.targetType === "config" && <span className="font-normal text-text-secondary">{t("common", H.onConfig)}</span>}
                  </p>
                  <p className="flex flex-wrap gap-x-3 text-text-secondary">
                    <span>{formatInstant(row.at, lang)}</span>
                    <span>{t("common", H.by, { actor: row.actorUserId.slice(0, 8) })}</span>
                  </p>
                  {row.reason && (
                    <p className="text-text-secondary" dir="auto">
                      {t("common", H.reason, { reason: row.reason })}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {answer.total > PAGE_SIZE && (
            <Pagination
              page={page}
              totalPages={Math.ceil(answer.total / PAGE_SIZE)}
              totalItems={answer.total}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </section>
  );
}
