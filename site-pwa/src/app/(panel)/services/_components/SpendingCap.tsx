"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { AlertCircle, Loader2, PiggyBank, RotateCw, UserRound } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, SPENDING_CAP_PERIODS, type SpendingCap as Cap, type SpendingCapPeriod } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { amountDraft, CAP_LABEL_MAX, capAmount, capReached } from "../_lib/spending-cap";

const K = FrontendI18nKeys.common.myServices.cap;

/** Each period's words — exhaustive, so a period added to the tuple without them does not compile. */
const PERIOD_TEXT: Record<SpendingCapPeriod, { label: string; hint: string }> = {
  none: { label: K.periodNone, hint: K.periodNoneHint },
  monthly: { label: K.periodMonthly, hint: K.periodMonthlyHint },
};

type Draft = { label: string; amount: string; period: SpendingCapPeriod };
type Refusal = { message: string; ref?: string };

/**
 * The owner's cap on one service's usage (F-118-j, over billing's
 * `/traffic/grants/:id/cap`, `billing/contract.spending-cap.md`): who it is
 * for, what it may cost, and what is spent, held and left of it.
 *
 * Mounted under "manage", so it reads once when that opens. Every figure is
 * billing's answer — a save or a removal shows what billing returned, never
 * the draft — and `onChanged` lets the page re-read the wallet, whose held
 * money a cap moves with no event to say so.
 */
export function SpendingCap({
  grantId,
  walletCurrency = null,
  onChanged,
}: {
  grantId: string;
  /** The wallet's currency, which a new cap is written in (billing rule 7); a cap's own answer names it after. */
  walletCurrency?: string | null;
  onChanged?: () => void;
}) {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();
  const ids = useId();

  /** `undefined` while reading; `null` is "no cap", which is an answer. */
  const [cap, setCap] = useState<Cap | null | undefined>(undefined);
  const [readError, setReadError] = useState<Refusal | null>(null);
  const [asked, setAsked] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState<"label" | "amount" | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refuse = useCallback((e: unknown) => setRefusal({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined }), [toMessage]);

  useEffect(() => {
    let alive = true;
    setReadError(null);
    billingApi
      .spendingCap(grantId)
      .then((answer) => alive && setCap(answer.cap))
      .catch((e: unknown) => alive && setReadError({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined }));
    return () => {
      alive = false;
    };
    // `toMessage` is rebuilt each render; the read is keyed to the service and a retry only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantId, asked]);

  const money = (v: string, currency: string) => formatMoney(v, currency, { lang, t });

  function edit() {
    setRefusal(null);
    setInvalid(null);
    setConfirmRemove(false);
    setDraft(cap ? { label: cap.label, amount: amountDraft(cap.amount), period: cap.period } : { label: "", amount: "", period: "none" });
  }

  async function save() {
    if (!draft || busy) return;
    const label = draft.label.trim();
    const amount = capAmount(draft.amount);
    if (label.length === 0 || label.length > CAP_LABEL_MAX) return setInvalid("label");
    if (amount === null) return setInvalid("amount");
    setInvalid(null);
    setRefusal(null);
    setBusy("save");
    try {
      const answer = await billingApi.setSpendingCap(grantId, { label, amount, period: draft.period });
      setCap(answer.cap);
      setDraft(null);
      onChanged?.();
    } catch (e) {
      // Nothing was stored: the form stays as typed, with billing's sentence.
      refuse(e);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setConfirmRemove(false);
    setRefusal(null);
    setBusy("remove");
    try {
      await billingApi.removeSpendingCap(grantId);
      setCap(null);
      onChanged?.();
    } catch (e) {
      refuse(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label={t("common", K.title)} className="rounded-2xl border border-card-border p-3">
      <p className="flex items-center gap-2 text-sm font-bold text-text-primary">
        <PiggyBank size={16} className="shrink-0 text-primary" aria-hidden />
        {t("common", K.title)}
      </p>
      <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", K.hint)}</p>

      {readError ? (
        <div className="mt-3 space-y-2">
          <ErrorLine error={readError} />
          <button
            type="button"
            onClick={() => setAsked((n) => n + 1)}
            className="flex items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg"
          >
            <RotateCw size={14} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : cap === undefined ? (
        <div className="mt-3 h-10 animate-pulse rounded-xl bg-bg-inner" aria-hidden />
      ) : draft ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          noValidate
        >
          <label className="block text-xs font-bold text-text-primary" htmlFor={`${ids}-label`}>
            {t("common", K.label)}
          </label>
          <input
            id={`${ids}-label`}
            value={draft.label}
            maxLength={CAP_LABEL_MAX}
            placeholder={t("common", K.labelPlaceholder)}
            aria-invalid={invalid === "label"}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className="w-full rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-primary"
            dir="auto"
          />
          {invalid === "label" && <p className="text-xs font-medium text-error">{t("common", K.invalidLabel)}</p>}

          <label className="block text-xs font-bold text-text-primary" htmlFor={`${ids}-amount`}>
            {t("common", K.amount, { currency: cap?.currencyCode ?? walletCurrency ?? "—" })}
          </label>
          <input
            id={`${ids}-amount`}
            value={draft.amount}
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={invalid === "amount"}
            onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            className="w-full rounded-xl border border-card-border bg-bg-inner px-3 py-2 font-mono text-sm text-text-primary"
            dir="ltr"
          />
          {invalid === "amount" && <p className="text-xs font-medium text-error">{t("common", K.invalidAmount)}</p>}

          <div role="radiogroup" aria-label={t("common", K.period)} className="grid gap-2 sm:grid-cols-2">
            {SPENDING_CAP_PERIODS.map((option) => {
              const checked = draft.period === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setDraft({ ...draft, period: option })}
                  className={`rounded-2xl border p-3 text-start transition-colors ${
                    checked ? "border-primary bg-leaf-bg" : "border-card-border bg-bg-inner hover:border-text-secondary"
                  }`}
                >
                  <span className="block text-sm font-bold text-text-primary">{t("common", PERIOD_TEXT[option].label)}</span>
                  <span className="block text-xs leading-5 text-text-secondary">{t("common", PERIOD_TEXT[option].hint)}</span>
                </button>
              );
            })}
          </div>
          {cap && cap.period !== draft.period && <p className="text-xs text-text-secondary">{t("common", K.periodRestarts)}</p>}

          {refusal && <ErrorLine error={refusal} />}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy !== null}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60"
            >
              {busy === "save" && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {t("common", busy === "save" ? K.saving : K.save)}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setDraft(null)}
              className="flex-1 rounded-xl bg-leaf-bg py-2.5 text-xs font-bold text-text-primary"
            >
              {t("common", K.cancel)}
            </button>
          </div>
        </form>
      ) : cap === null ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-text-secondary">{t("common", K.none)}</p>
          {refusal && <ErrorLine error={refusal} />}
          <button
            type="button"
            onClick={edit}
            className="rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg"
          >
            {t("common", K.set)}
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="flex items-center gap-2 text-sm text-text-primary">
            <UserRound size={14} className="shrink-0 text-text-secondary" aria-hidden />
            <span className="font-bold" dir="auto">
              {cap.label}
            </span>
            <span className="text-xs text-text-secondary" dir="auto">
              · {t("common", K.limit, { amount: money(cap.amount, cap.currencyCode) })}
            </span>
          </p>
          <dl className="grid grid-cols-3 gap-2 text-center">
            {(
              [
                [K.spent, cap.spent],
                [K.held, cap.held],
                [K.left, cap.left],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="rounded-xl bg-bg-inner px-2 py-2">
                <dt className="text-[10px] font-bold text-text-secondary">{t("common", key)}</dt>
                <dd className="mt-0.5 font-mono text-xs font-bold text-text-primary">{money(value, cap.currencyCode)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-text-secondary">
            {cap.period === "monthly"
              ? t("common", K.periodSince, { date: formatInstant(cap.periodStartsAt, lang, { withTime: false }) ?? cap.periodStartsAt })
              : t("common", K.periodLife)}
          </p>
          {capReached(cap) && (
            <p role="status" className="flex items-start gap-2 rounded-xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
              {t("common", K.reached)}
            </p>
          )}

          {refusal && <ErrorLine error={refusal} />}

          {confirmRemove ? (
            <div className="rounded-2xl border border-error-border bg-error-bg p-3">
              <p className="text-sm font-bold text-error">{t("common", K.removeConfirm)}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" autoFocus onClick={() => setConfirmRemove(false)} className="flex-1 rounded-xl bg-primary py-2.5 text-xs font-bold text-white">
                  {t("common", K.removeNo)}
                </button>
                <button type="button" onClick={() => void remove()} className="flex-1 rounded-xl bg-leaf-bg py-2.5 text-xs font-bold text-text-primary">
                  {t("common", K.removeYes)}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={edit}
                disabled={busy !== null}
                className="rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
              >
                {t("common", K.edit)}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
              >
                {busy === "remove" && <Loader2 size={14} className="animate-spin" aria-hidden />}
                {t("common", busy === "remove" ? K.removing : K.remove)}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Billing's sentence for a refused read or write, and its ref for support. */
function ErrorLine({ error }: { error: Refusal }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
      <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        {error.message}
        {error.ref && (
          <span className="mt-1 block font-mono text-[0.65rem] opacity-70" dir="ltr">
            {error.ref}
          </span>
        )}
      </span>
    </div>
  );
}
