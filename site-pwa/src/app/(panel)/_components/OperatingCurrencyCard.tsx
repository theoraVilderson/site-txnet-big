"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import {
  operatingCurrencyApi,
  type CurrencyChangeSummary,
  type OperatingCurrency,
  type OperatingCurrencyChange,
} from "@/lib/tenant-api";
import { Alert, input, primaryButton, quietButton } from "../catalog/_components/catalog-ui";
import { TableSkeleton } from "./kit/TableSkeleton";

const K = FrontendI18nKeys.common.operatingCurrency;

/** The route's refusals (`tenant/contract.currency.md`), each with its own sentence. */
type Refusal = keyof typeof K.refusals;
const refusalOf = (e: unknown): Refusal | null => {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in K.refusals ? (reason as Refusal) : null;
};

/** Summary kinds in the order they are listed; a kind with nothing converted is not. */
const KINDS = Object.keys(K.summary) as (keyof CurrencyChangeSummary)[];

/**
 * A tenant's operating currency, read and changed (F-116-h,
 * `tenant/contract.currency.md`). `scope` says whose: a reseller's, from its
 * workspace, or the platform's own, from `/settings` — whose change also
 * converts every reseller's billing (rule 3), so the confirm says so.
 *
 *  - **a change is never one click.** `PUT` converts live money at one rate
 *    snapshot; it is sent only after a sentence naming both currencies;
 *  - **what was converted is the answer's**, never inferred from the pick;
 *  - **`currency_changed` re-reads.** Another admin won; the card shows what
 *    the tenant is in now instead of retrying from a stale one.
 */
export function OperatingCurrencyCard({ tenantId, scope }: { tenantId: string; scope: "reseller" | "platform" }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const refusal = refusalOf(e);
    return refusal ? t("common", K.refusals[refusal]) : errorMessage(e);
  };

  const [view, setView] = useState<OperatingCurrency | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [picked, setPicked] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [done, setDone] = useState<OperatingCurrencyChange["conversion"]>(null);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    operatingCurrencyApi
      .get(tenantId)
      .then((v) => {
        if (!alive) return;
        setView(v);
        setPicked(v.code);
      })
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [tenantId, asked]);

  const nameOf = (code: string) => view?.choices.find((c) => c.code === code)?.name ?? code;

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const answer = await operatingCurrencyApi.set(tenantId, picked);
      setView({ code: answer.code, choices: answer.choices });
      setPicked(answer.code);
      setDone(answer.conversion);
    } catch (e) {
      setFailure(e);
      if (refusalOf(e) === "currency_changed") setAsked((n) => n + 1);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section className="mt-6 rounded-3xl border border-card-border bg-card-bg p-6">
      <h2 className="mb-1 text-lg font-bold text-text-primary">{t("common", K.title)}</h2>
      <p className="mb-5 text-sm text-text-secondary">
        {t("common", scope === "platform" ? K.hintPlatform : K.hint)}
      </p>

      {loadError !== null ? (
        <div className="space-y-3">
          <Alert>{message(loadError)}</Alert>
          <button type="button" className={quietButton} onClick={() => setAsked((n) => n + 1)}>
            {t("common", K.reload)}
          </button>
        </div>
      ) : view === null ? (
        <TableSkeleton rows={1} columns={2} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1">
              <span className="mb-1 block text-sm text-text-secondary">{t("common", K.label)}</span>
              <select
                className={input}
                value={picked}
                disabled={busy || confirming}
                onChange={(e) => {
                  setPicked(e.target.value);
                  setFailure(null);
                  setDone(null);
                }}
              >
                {view.choices.map((c) => (
                  <option key={c.code} value={c.code}>
                    {t("common", K.choice, { name: c.name, code: c.code })}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={primaryButton}
              disabled={busy || confirming || picked === view.code}
              onClick={() => setConfirming(true)}
            >
              {t("common", K.change)}
            </button>
          </div>

          {confirming && (
            <div className="space-y-3 rounded-2xl border border-gold/20 bg-gold-bg p-4">
              <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
                <AlertTriangle size={16} className="shrink-0 text-gold" aria-hidden />
                {t("common", K.confirm.title, { from: nameOf(view.code), to: nameOf(picked) })}
              </h3>
              <p className="text-sm text-text-primary">{t("common", K.confirm.body, { from: view.code, to: picked })}</p>
              {scope === "platform" && <p className="text-sm font-bold text-text-primary">{t("common", K.confirm.platform)}</p>}
              <div className="flex gap-2">
                <button type="button" className={primaryButton} disabled={busy} onClick={submit}>
                  {t("common", K.confirm.yes)}
                </button>
                <button type="button" className={quietButton} disabled={busy} onClick={() => setConfirming(false)}>
                  {t("common", K.confirm.no)}
                </button>
              </div>
            </div>
          )}

          {failure !== null && <Alert>{message(failure)}</Alert>}

          {done && (
            <div className="space-y-2 rounded-2xl border border-primary/20 bg-leaf-bg p-4">
              <p className="flex items-center gap-2 text-sm font-bold text-text-primary">
                <CheckCircle2 size={16} className="shrink-0 text-primary" aria-hidden />
                {t("common", K.done.title, { from: done.fromCode, to: view.code, rate: done.rate })}
              </p>
              {KINDS.some((k) => done.summary[k] > 0) ? (
                <ul className="list-inside list-disc text-sm text-text-primary">
                  {KINDS.filter((k) => done.summary[k] > 0).map((k) => (
                    <li key={k}>{t("common", K.summary[k], { count: done.summary[k] })}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-secondary">{t("common", K.done.nothing)}</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
