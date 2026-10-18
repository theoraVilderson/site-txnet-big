"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RotateCw, Ticket } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { lotteryAdminApi, type AdminLottery } from "@/lib/engagement-api";
import { panelLotteryManagePath } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatInstant } from "../../../_lib/datetime";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { LOTTERY_ADMIN_KEYS as K, canManageLotteries } from "../_lib/lottery-admin";
import { LotteryWizard } from "./LotteryWizard";
import { StatusPill, useLotteryMessage } from "./lottery-admin-ui";
import { PageHeader } from "../../../_components/kit/PageHeader";
import { Alert, Button, buttonClass } from "../../../_components/kit";

/**
 * A tenant admin's lotteries (F-707-o), over billing's
 * `/api/billing/engagement/lotteries` (F-707-i): every lottery, newest first,
 * and a new draft. One lottery's acts live on its own page.
 *
 * The check here only spares a caller who typed the path a refused read.
 */
export function LotteryAdminView() {
  const { lang, t } = useLocale();
  const router = useRouter();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const message = useLotteryMessage();
  const allowed = canManageLotteries(me);

  const [rows, setRows] = useState<AdminLottery[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    lotteryAdminApi
      .list()
      .then((list) => {
        if (!alive) return;
        setRows(list);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [allowed, asked]);

  if (sessionLoading) return null;
  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 md:p-8">
        <Alert tone="error">{t("common", K.notAllowed)}</Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <PageHeader
        icon={Ticket}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            {!creating && (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} aria-hidden />}>
                {t("common", K.newLottery)}
              </Button>
            )}
          </>
        }
      />

      {creating && <LotteryWizard from={null} onClose={() => setCreating(false)} onSaved={(l) => router.push(panelLotteryManagePath(l.id))} />}

      {error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{message(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
        </div>
      ) : rows === null ? (
        <TableSkeleton rows={4} columns={4} withPagination={false} />
      ) : rows.length === 0 ? (
        !creating && <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-col gap-2 rounded-2xl border border-card-border bg-card-bg p-4 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
                  <span dir="auto">{l.title}</span>
                  <StatusPill lottery={l} />
                </p>
                <p className="text-xs text-text-secondary">
                  {t("common", K.list.closesAt, { time: formatInstant(l.closesAt, lang) ?? "—" })} · {t("common", K.mode[l.entryMode])} ·{" "}
                  {t("common", K.list.winnersTotal, { n: l.winnersTotal })}
                  {l.status !== "draft" && <> · {t("common", K.list.entrants, { n: l.entrantCount })}</>}
                </p>
              </div>
              <Link href={panelLotteryManagePath(l.id)} className={buttonClass({ variant: "quiet", size: "sm" })}>
                {t("common", K.open)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
