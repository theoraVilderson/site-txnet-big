"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Gift, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { wheelApi, type SpinResult, type UserWheel, type WheelHistoryRow } from "@/lib/engagement-api";
import { copyText } from "../../_lib/clipboard";
import { formatInstant } from "../../_lib/datetime";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { WHEEL_KEYS as K, landingRotation, nextRequestId, oddsLine, refusalKey, refusalKeyOf, resultLine } from "../_lib/wheel";
import { WheelDisc } from "./WheelDisc";
import { useCatalogTexts } from "../../catalog/_lib/meter-names";
import { PageHeader } from "../../_components/kit/PageHeader";
import { PrizeServicePicker } from "../../_components/PrizeServicePicker";
import { celebrate } from "../../_components/kit/celebrate";
import { Alert, Button } from "../../_components/kit";

/** How long the wheel turns; the answer is already in hand when it starts. */
const SPIN_MS = 4500;

/**
 * The user's lucky wheel (F-707-g), over billing's `/api/billing/wheel`
 * (F-707-d). Billing decides everything: whether this user may spin, and the
 * slot. The page shows the public odds, says why not, and turns the wheel to
 * the slot it is told — it never draws a number (ADR-0111 point 4).
 */
export function WheelView() {
  const { lang, t } = useLocale();
  const texts = useCatalogTexts();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };

  const [wheel, setWheel] = useState<UserWheel | null>(null);
  const [history, setHistory] = useState<WheelHistoryRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [noWheel, setNoWheel] = useState(false);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);

  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<SpinResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // One tap's key: kept across a lost answer, so a retry is the same spin.
  const requestId = useRef<string>(nextRequestId("", "answered"));

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [w, h] = await Promise.all([wheelApi.view(), wheelApi.history().catch(() => null)]);
        if (!alive) return;
        setWheel(w);
        setHistory(h);
        setNoWheel(false);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setWheel(null);
        if ((e as { reason?: unknown } | null)?.reason === "no_wheel") setNoWheel(true);
        else setError(e);
      } finally {
        if (alive) setLoaded(asked);
      }
    })();
    return () => {
      alive = false;
    };
  }, [asked]);

  async function spin() {
    if (!wheel || spinning) return;
    setFailure(null);
    setResult(null);
    setCopied(false);
    let answer: SpinResult;
    try {
      answer = await wheelApi.spin(requestId.current);
    } catch (e) {
      // A named refusal recorded nothing, so the next tap is new; anything else
      // may have spun, and `spin_in_progress` is this very tap still running.
      const reason = (e as { reason?: unknown } | null)?.reason;
      const answered = typeof reason === "string" && reason !== "spin_in_progress";
      requestId.current = nextRequestId(requestId.current, answered ? "answered" : "lost");
      setFailure(message(e));
      return;
    }
    requestId.current = nextRequestId(requestId.current, "answered");
    if (answer.position === null) {
      setResult(answer);
      reload();
      return;
    }
    setSpinning(true);
    setRotation((from) => landingRotation(from, answer.position as number, wheel.prizes.length));
    window.setTimeout(() => {
      setSpinning(false);
      setResult(answer);
      // M5: when the wheel stops on a prize; an empty slot is not one.
      if (answer.prize && answer.prize.prizeType !== "empty") celebrate();
      reload();
    }, SPIN_MS);
  }

  const line = result && resultLine(result, texts);
  const coupon = result?.reward?.coupon ?? null;
  const ready = loaded === asked || wheel !== null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <PageHeader
        icon={Gift}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
      />

      {!ready ? (
        <p className="text-sm text-text-secondary">{t("common", K.loading)}</p>
      ) : noWheel ? (
        <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">{t("common", K.noWheel)}</p>
      ) : error || !wheel ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{message(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="flex flex-col items-center gap-4 rounded-2xl border border-card-border bg-card-bg p-6">
            <WheelDisc slots={wheel.prizes.map((p) => p.label)} rotation={rotation} durationMs={SPIN_MS} />
            <Button variant="primary" size="lg" className="px-8" disabled={!wheel.eligible || spinning} onClick={spin}>
              {t("common", spinning ? K.spinning : K.spin)}
            </Button>
            {wheel.eligible ? (
              <p className="text-xs text-text-secondary">{t("common", K.spinsLeft, { n: wheel.spinsLeftToday })}</p>
            ) : (
              <div className="text-center text-xs">
                <p className="font-bold text-text-primary">{t("common", K.notEligible)}</p>
                {wheel.refusalReason && <p className="mt-1 text-text-secondary">{t("common", refusalKeyOf(wheel.refusalReason) ?? K.notEligible)}</p>}
              </div>
            )}
            {wheel.nextSpinAt && <p className="text-xs text-text-secondary">{t("common", K.nextSpinAt, { time: formatInstant(wheel.nextSpinAt, lang) ?? "" })}</p>}

            {failure && <Alert tone="error">{failure}</Alert>}
            {line && !spinning && (
              <div role="status" className="w-full rounded-xl bg-bg-inner p-4 text-center text-sm">
                <p className="font-bold text-text-primary">{t("common", line.key, { ...line.values, reason: line.reason ? t("common", line.reason) : "" })}</p>
                {coupon && (
                  <div className="mt-2 flex flex-col items-center gap-1 text-xs">
                    <p dir="ltr" className="font-mono text-base font-bold text-text-primary">
                      {coupon.code}
                    </p>
                    <p className="text-text-secondary">{t("common", K.coupon.expires, { date: formatInstant(coupon.expiresAt, lang, { withTime: false }) ?? "" })}</p>
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={async () => setCopied(await copyText(coupon.code))}
                      icon={copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    >
                      {t("common", copied ? K.coupon.copied : K.coupon.copy)}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="space-y-6">
            <PrizeServicePicker />
            <div className="rounded-2xl border border-card-border bg-card-bg p-4">
              <h2 className="text-sm font-bold text-text-primary">{t("common", K.odds.title)}</h2>
              <p className="mt-1 text-xs text-text-secondary">{t("common", K.odds.note)}</p>
              <ul className="mt-3 divide-y divide-card-border text-sm">
                {wheel.prizes.map((p) => {
                  const odds = oddsLine(p);
                  return (
                    <li key={p.position} className="flex items-center justify-between gap-3 py-2">
                      <span dir="auto" className="text-text-primary">
                        {p.label}
                      </span>
                      <span className="font-bold text-text-secondary">{t("common", odds.key, odds.values)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="rounded-2xl border border-card-border bg-card-bg p-4">
              <h2 className="text-sm font-bold text-text-primary">{t("common", K.history.title)}</h2>
              {history === null ? (
                <TableSkeleton rows={3} columns={2} withPagination={false} />
              ) : history.length === 0 ? (
                <p className="mt-2 text-xs text-text-secondary">{t("common", K.history.empty)}</p>
              ) : (
                <ul className="mt-2 divide-y divide-card-border text-xs">
                  {history.map((h) => (
                    <li key={h.attemptId} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                      <span className="text-text-secondary">{formatInstant(h.at, lang)}</span>
                      <span dir="auto" className="text-end text-text-primary">
                        {h.status !== "awarded"
                          ? t("common", K.history.refused, { reason: t("common", refusalKeyOf(h.refusalReason) ?? K.notEligible) })
                          : h.prize && h.prize.prizeType !== "empty"
                            ? h.prize.label
                            : t("common", K.history.nothing)}
                        {h.coupon && (
                          <span dir="ltr" className="ms-2 font-mono font-bold">
                            {h.coupon.code}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
