"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, Ticket, Trash2, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GiftRedemption } from "@/lib/billing-api";
import { BASE_CURRENCY, formatMoney } from "../_lib/money";

/** The modal's strings as generated constants (C-06). */
const G = FrontendI18nKeys.common.wallet.gift;

interface GiftCodeModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * A code was redeemed. The top bar re-reads its balance on this; it is
   * deliberately **not** handed an amount to add, for the reason in the header
   * comment below. The answer is passed only so a caller can log or show it.
   */
  onRedeemed?: (redemption: GiftRedemption) => void;
}

/**
 * The gift-code box (F-093-g), ported from legacy's `DiscountModal.tsx` with
 * its one bug left behind.
 *
 * Legacy branched on `data.status === "nok"`, set an error — and then ran the
 * success path anyway, because the branch had no `return`. Every answer,
 * refusal included, did `walletBalance + data.amount` into a client store, and
 * on a refusal `amount` is undefined: a dead code showed "gift activated" over
 * a balance of `NaN`. Two rules replace it, and both are older than this file:
 *
 * 1. **A refusal ends the submit.** Failure is an `ApiError` thrown by the
 *    client, so there is no success path to fall into — the sentence billing
 *    already translated goes on screen and nothing else happens
 *    (`contract.errors.md`). Each of the five refusals names where the code
 *    does belong, so this keeps no copy of any of them and no reason code to
 *    branch on.
 * 2. **This does not touch the balance.** It reports that a redemption
 *    happened; `useWalletBalance` re-reads the figure from billing, which is
 *    the only thing that can be right (`contract.shell.md` rule 1). The
 *    `credited` and `balance` shown here are billing's own answer to *this*
 *    call, formatted, never a sum worked out on this side.
 *
 * Legacy also dismissed itself on a timer, and the timer read a `status` from a
 * stale closure to decide whether to. The success panel here stays until it is
 * closed: the user has just been told a number they may want to read twice.
 */
export function GiftCodeModal({ open, onClose, onRedeemed }: GiftCodeModalProps) {
  // The dialog's state lives one level down so that **mounting is the reset**:
  // a closed modal holds no half-typed code and no previous attempt's error,
  // without an effect that has to remember to clear each one.
  if (!open) return null;
  return <GiftCodeDialog onClose={onClose} onRedeemed={onRedeemed} />;
}

function GiftCodeDialog({ onClose, onRedeemed }: Omit<GiftCodeModalProps, "open">) {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);
  const [redeemed, setRedeemed] = useState<GiftRedemption | null>(null);

  // The code box is what the user came here to fill in.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const trimmed = code.trim();
  const canSubmit = trimmed.length > 0 && !isSubmitting && redeemed === null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    // Cleared per attempt: the previous refusal is no longer the answer
    // (`contract.errors.md`).
    setError(null);
    setIsSubmitting(true);
    try {
      const redemption = await billingApi.redeemGift(trimmed);
      setRedeemed(redemption);
      onRedeemed?.(redemption);
    } catch (e) {
      // The only exit from a failure. There is no `setRedeemed` below it, which
      // is the whole difference from the file this was ported from.
      console.error(e);
      setError({
        message: toMessage(e),
        ref: e instanceof ApiError ? e.ref : undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  const money = (amount: string) => formatMoney(amount, BASE_CURRENCY, { lang, t });

  return (
    // Above the sidebar's `z-40` and its `z-30` backdrop (`contract.shell.md`,
    // "State"): a modal the drawer could cover is a modal the user cannot use.
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-3xl border border-card-border bg-card-bg p-6 shadow-2xl backdrop-blur-xl sm:p-8"
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-white">
              <Ticket size={24} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-bold text-text-primary">
                {t("common", G.title)}
              </h2>
              <p className="mt-0.5 text-xs text-text-secondary">{t("common", G.subtitle)}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common", G.close)}
            className="rounded-xl p-2 text-text-secondary transition-colors hover:bg-leaf-bg hover:text-text-primary"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        {redeemed ? (
          <div className="text-center">
            <span className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-primary text-white">
              <Check size={28} aria-hidden />
            </span>
            <p className="text-base font-bold text-text-primary">
              {t("common", G.successTitle)}
            </p>
            <p className="mt-2 text-sm text-text-secondary">
              {t("common", G.credited, { amount: money(redeemed.credited) })}
            </p>
            <p className="mt-1 font-mono text-sm font-bold text-gold">
              {t("common", G.newBalance, { balance: money(redeemed.balance) })}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 w-full rounded-2xl bg-primary py-3 text-sm font-bold text-white transition hover:brightness-110"
            >
              {t("common", G.done)}
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label
                htmlFor={`${titleId}-code`}
                className="mb-2 block text-xs font-bold text-text-secondary"
              >
                {t("common", G.inputLabel)}
              </label>
              <div className="relative flex items-center">
                <input
                  id={`${titleId}-code`}
                  ref={inputRef}
                  type="text"
                  dir="ltr"
                  maxLength={64}
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  disabled={isSubmitting}
                  placeholder={t("common", G.placeholder)}
                  className="w-full rounded-2xl border-2 border-card-border bg-bg-inner px-4 py-4 text-center font-mono text-lg font-bold tracking-[0.15em] text-text-primary outline-none transition-colors placeholder:tracking-normal placeholder:text-text-secondary/40 focus:border-primary disabled:opacity-60"
                />
                {code && !isSubmitting && (
                  <button
                    type="button"
                    onClick={() => {
                      setCode("");
                      inputRef.current?.focus();
                    }}
                    aria-label={t("common", G.clear)}
                    className="absolute end-3 p-2 text-text-secondary/50 transition-colors hover:text-error"
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                )}
              </div>
            </div>

            {/* The sentence is billing's, already translated — this only lays it
                out. `role="alert"` because it lands after a submit the user is
                waiting on (`contract.errors.md`). */}
            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="flex items-start gap-3 rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm font-medium text-error"
              >
                <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0">
                  {error.message}
                  {error.ref && (
                    <span className="mt-1 block font-mono text-[0.65rem] opacity-70" dir="ltr">
                      {error.ref}
                    </span>
                  )}
                </span>
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-sm font-bold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" aria-hidden />
                  {t("common", G.submitting)}
                </>
              ) : (
                t("common", G.submit)
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
