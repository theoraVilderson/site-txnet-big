"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, ShieldCheck, Ticket } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { lotteryApi, type LotteryResult } from "@/lib/engagement-api";
import { PANEL_LOTTERIES } from "@/lib/routes";
import { formatInstant } from "../../_lib/datetime";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Alert, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { LOTTERY_KEYS as K, passedOnKeyOf, refusalKey, verifyDraw, type VerifyOutcome } from "../_lib/lotteries";

/**
 * One drawn lottery's result (F-707-n), from billing's
 * `GET /lotteries/:id/result` (F-707-m), and the user's own check of it: the
 * browser redoes the draw from the published seed and ticket list with the
 * same code billing drew with (`verifyDraw`, ADR-0111 point 5).
 */
export function LotteryResultView({ id }: { id: string }) {
  const { lang, t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [result, setResult] = useState<LotteryResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<VerifyOutcome | "failed" | null>(null);

  useEffect(() => {
    let alive = true;
    lotteryApi
      .result(id)
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id]);

  async function check() {
    if (!result) return;
    setChecking(true);
    setVerdict(null);
    try {
      setVerdict(await verifyDraw(result));
    } catch {
      setVerdict("failed");
    } finally {
      setChecking(false);
    }
  }

  const verdictText = (v: VerifyOutcome | "failed") => {
    if (v === "failed") return t("common", K.verify.failed);
    if (v.outcome === "ok") return t("common", K.verify.ok);
    if (v.outcome === "list_mismatch") return t("common", K.verify.listMismatch);
    if (v.outcome === "unknown_algorithm") return t("common", K.verify.unknownAlgorithm, { algorithm: result?.algorithm ?? "" });
    return t("common", K.verify.placesMismatch, { list: v.positions.join(", ") });
  };
  const mine = result?.mine?.ticketNumber ?? null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <Link href={PANEL_LOTTERIES} className={quietButton}>
        <ArrowRight size={12} aria-hidden className="ltr:rotate-180" />
        {t("common", K.result.back)}
      </Link>

      {error ? (
        <Alert>{refusalKey(error) ? t("common", refusalKey(error) as string) : errorMessage(error)}</Alert>
      ) : !result ? (
        <TableSkeleton rows={4} columns={2} withPagination={false} />
      ) : (
        <>
          <header>
            <h1 dir="auto" className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
              <Ticket size={22} className="text-primary" aria-hidden />
              {result.title}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t("common", K.result.drawnAt, { time: formatInstant(result.drawnAt, lang) ?? "" })} · {t("common", K.result.tickets, { n: result.entrantCount })}
            </p>
            {mine !== null && <p className="mt-1 text-sm font-bold text-text-primary">{t("common", K.ticket, { n: mine })}</p>}
          </header>

          <section className="rounded-2xl border border-card-border bg-card-bg p-4">
            <h2 className="text-sm font-bold text-text-primary">{t("common", K.result.placesTitle)}</h2>
            {result.places.length === 0 ? (
              <p className="mt-2 text-xs text-text-secondary">{t("common", K.result.noPlaces)}</p>
            ) : (
              <ul className="mt-2 divide-y divide-card-border text-xs">
                {result.places.map((p) => (
                  <li key={p.position} className={`flex flex-wrap items-baseline justify-between gap-2 py-2 ${p.ticketNumber === mine ? "font-bold" : ""}`}>
                    <span className="text-text-primary">
                      {t("common", K.result.place, { n: p.position })} · {t("common", K.result.ticket, { n: p.ticketNumber })}
                      {p.ticketNumber === mine && <span className="ms-2 text-primary">{t("common", K.result.mine)}</span>}
                    </span>
                    <span dir="auto" className="text-end text-text-secondary">
                      {p.prize ? p.prize.label : t("common", K.result.reserve)}
                      {p.prize && <> · {t("common", K.result.delivery[p.delivery])}</>}
                      {p.delivery === "passed_on" && passedOnKeyOf(p.passedOnReason) && <> ({t("common", passedOnKeyOf(p.passedOnReason) as string)})</>}
                      {p.replacesPosition !== null && <> · {t("common", K.result.replaces, { n: p.replacesPosition })}</>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary">
              <ShieldCheck size={16} className="text-primary" aria-hidden />
              {t("common", K.verify.title)}
            </h2>
            <p className="text-xs text-text-secondary">{t("common", K.verify.note)}</p>
            <dl className="grid gap-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
              <dt className="text-text-secondary">{t("common", K.verify.algorithm)}</dt>
              <dd dir="ltr" className="break-all font-mono text-text-primary">{result.algorithm}</dd>
              <dt className="text-text-secondary">{t("common", K.verify.seed)}</dt>
              <dd dir="ltr" className="break-all font-mono text-text-primary">{result.seed}</dd>
              <dt className="text-text-secondary">{t("common", K.verify.listHash)}</dt>
              <dd dir="ltr" className="break-all font-mono text-text-primary">{result.listHash}</dd>
            </dl>
            <button type="button" className={primaryButton} disabled={checking} onClick={check}>
              {t("common", checking ? K.verify.running : K.verify.run)}
            </button>
            {verdict && (
              <p role="status" className={`rounded-xl bg-bg-inner p-3 text-xs ${verdict !== "failed" && verdict.outcome === "ok" ? "text-text-primary" : "font-bold text-text-primary"}`}>
                {verdictText(verdict)}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
