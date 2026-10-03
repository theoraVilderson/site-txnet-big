"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RotateCw, Ticket } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { lotteryApi, type UserLottery } from "@/lib/engagement-api";
import { panelLotteryPath } from "@/lib/routes";
import { formatInstant } from "../../_lib/datetime";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Alert, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { LOTTERY_KEYS as K, entryState, excludedKeyOf, refusalKey, statusKey } from "../_lib/lotteries";

/**
 * The user's lotteries (F-707-n), over billing's `/api/billing/lotteries`
 * (F-707-j). Billing decides who sees a lottery, who may join and who got a
 * ticket; the page shows it, joins and leaves, and opens a drawn one's result.
 */
export function LotteriesView() {
  const { lang, t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const [lotteries, setLotteries] = useState<UserLottery[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    lotteryApi
      .list()
      .then((rows) => {
        if (!alive) return;
        setLotteries(rows);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [asked]);

  async function act(l: UserLottery, join: boolean) {
    setBusy(l.id);
    setFailure(null);
    try {
      await (join ? lotteryApi.join(l.id) : lotteryApi.leave(l.id));
    } catch (e) {
      setFailure({ id: l.id, text: message(e) });
    } finally {
      setBusy(null);
      reload();
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
          <Ticket size={22} className="text-primary" aria-hidden />
          {t("common", K.title)}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
      </header>

      {error && !lotteries ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : lotteries === null ? (
        <TableSkeleton rows={3} columns={2} withPagination={false} />
      ) : lotteries.length === 0 ? (
        <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <ul className="space-y-4">
          {lotteries.map((l) => {
            const state = entryState(l);
            return (
              <li key={l.id} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 dir="auto" className="text-base font-bold text-text-primary">
                      {l.title}
                    </h2>
                    {l.description && (
                      <p dir="auto" className="mt-1 text-xs text-text-secondary">
                        {l.description}
                      </p>
                    )}
                  </div>
                  <span className="rounded-full bg-bg-inner px-2 py-0.5 text-xs font-bold text-text-secondary">{t("common", statusKey(l))}</span>
                </div>

                <p className="text-xs text-text-secondary">{t("common", K.closesAt, { time: formatInstant(l.closesAt, lang) ?? "" })}</p>
                {l.status === "cancelled" && l.cancelReason && (
                  <p dir="auto" className="text-xs font-bold text-text-primary">
                    {t("common", K.cancelled, { reason: l.cancelReason })}
                  </p>
                )}

                {l.prizes.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-text-primary">{t("common", K.prizesTitle)}</h3>
                    <ul className="mt-1 space-y-1 text-xs">
                      {l.prizes.map((p) => (
                        <li key={p.rank} className="flex justify-between gap-3">
                          <span dir="auto" className="text-text-primary">
                            {t("common", K.prize, { rank: String(p.rank), label: p.label })}
                          </span>
                          <span className="text-text-secondary">{t("common", K.winners, { n: p.winnersCount })}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3 text-xs">
                  {state === "automatic" && <p className="text-text-secondary">{t("common", K.mode.automatic)}</p>}
                  {state === "can_join" && (
                    <>
                      <p className="text-text-secondary">{t("common", K.mode.opt_in)}</p>
                      <button type="button" className={primaryButton} disabled={busy === l.id} onClick={() => act(l, true)}>
                        {t("common", K.join)}
                      </button>
                    </>
                  )}
                  {state === "can_leave" && (
                    <>
                      <p className="text-text-primary">{t("common", K.joined)}</p>
                      <button type="button" className={quietButton} disabled={busy === l.id} onClick={() => act(l, false)}>
                        {t("common", K.leave)}
                      </button>
                    </>
                  )}
                  {state === "ticket" && <p className="font-bold text-text-primary">{t("common", K.ticket, { n: l.entry?.ticketNumber ?? 0 })}</p>}
                  {state === "excluded" && (
                    <p className="text-text-secondary">
                      <span className="font-bold text-text-primary">{t("common", K.excludedTitle)}</span>
                      {excludedKeyOf(l.entry?.excludedReason) && <> — {t("common", excludedKeyOf(l.entry?.excludedReason) as string)}</>}
                    </p>
                  )}
                  {l.status === "drawn" && (
                    <Link href={panelLotteryPath(l.id)} className={quietButton}>
                      {t("common", K.viewResult)}
                    </Link>
                  )}
                </div>
                {failure?.id === l.id && <Alert>{failure.text}</Alert>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
