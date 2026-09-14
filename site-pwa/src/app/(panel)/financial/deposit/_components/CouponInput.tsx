"use client";

import { useId, useState } from "react";
import { Sparkles, Ticket, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { DepositQuote } from "@/lib/billing-api";
import { BASE_CURRENCY, formatMoney } from "../../../_lib/money";

const D = FrontendI18nKeys.common.deposit.coupon;

interface CouponInputProps {
  /** The codes on the page, in the order they were added. */
  codes: string[];
  onAdd: (code: string) => void;
  onRemove: (code: string) => void;
  /** The quote for the current inputs, or `null` while there is none. */
  quote: DepositQuote | null;
  disabled?: boolean;
}

/**
 * The discount codes (F-093-e).
 *
 * **There is no validate-one-code call here, and that is the whole design.**
 * Legacy checked each code against its own endpoint, kept the answer in
 * component state, and then re-checked the whole list on every amount change —
 * three places holding what a coupon was worth, drifting apart whenever one of
 * them failed. Here a code is *added to the inputs*, the quote is re-asked with
 * the full list, and the quote's own `coupons` / `rejected` are the only answer
 * on screen. A code that stops applying when the amount changes says so on the
 * next quote without anything here noticing.
 *
 * **A rejected code stays in the list, marked.** It is the user's typo to fix
 * or remove, and silently dropping it is how a code the user believes is
 * applied disappears between renders. The sentence beside it is billing's,
 * already translated, and this app keeps no copy of any of them
 * (`contract.errors.md`).
 */
export function CouponInput({ codes, onAdd, onRemove, quote, disabled }: CouponInputProps) {
  const { lang, t } = useLocale();
  const [typed, setTyped] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const inputId = useId();

  const applied = new Map((quote?.coupons ?? []).map((c) => [c.code.toUpperCase(), c.discount]));
  const rejected = new Map((quote?.rejected ?? []).map((r) => [r.code.toUpperCase(), r.message]));

  function submit() {
    const code = typed.trim();
    if (!code) return;
    if (codes.some((c) => c.toUpperCase() === code.toUpperCase())) {
      setDuplicate(true);
      return;
    }
    onAdd(code);
    setTyped("");
    setDuplicate(false);
  }

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-leaf-bg text-primary">
          <Ticket size={16} aria-hidden />
        </span>
        <label htmlFor={inputId} className="text-sm font-bold text-text-primary">
          {t("common", D.label)}
        </label>
      </div>

      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          disabled={disabled}
          value={typed}
          placeholder={t("common", D.placeholder)}
          onChange={(e) => {
            setTyped(e.target.value);
            setDuplicate(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full rounded-2xl border-2 border-card-border bg-bg-inner px-4 py-3 text-sm font-bold text-text-primary outline-none transition-colors focus:border-primary disabled:opacity-50"
        />
        <button
          type="button"
          disabled={disabled || !typed.trim()}
          onClick={submit}
          className="shrink-0 rounded-2xl bg-primary px-4 text-sm font-bold text-white transition-[filter] hover:brightness-110 disabled:opacity-40"
        >
          {t("common", D.add)}
        </button>
      </div>

      {/* The one message this box owns: the code is already on the page, so
          there is nothing to ask billing about. Every other verdict is the
          quote's. */}
      {duplicate && (
        <p role="alert" className="mt-3 text-xs font-bold text-error">
          {t("common", D.duplicate)}
        </p>
      )}

      {codes.length > 0 && (
        <div className="mt-5 space-y-2">
          <p className="px-1 text-xs font-bold text-text-secondary">
            {t("common", D.applied, { count: codes.length })}
          </p>
          {codes.map((code) => {
            const key = code.toUpperCase();
            const discount = applied.get(key);
            const refusal = rejected.get(key);
            return (
              <div
                key={key}
                className={`flex items-start gap-3 rounded-2xl border p-3 ${
                  refusal ? "border-error-border bg-error-bg/30" : "border-card-border bg-bg-inner"
                }`}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-leaf-bg text-primary">
                  <Sparkles size={16} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold tracking-wide text-text-primary">{key}</span>
                    {discount !== undefined && (
                      <span className="rounded-md bg-leaf-bg px-1.5 py-0.5 text-[10px] font-bold text-primary">
                        {t("common", D.active)}
                      </span>
                    )}
                    {refusal && (
                      <span className="rounded-md bg-error-bg px-1.5 py-0.5 text-[10px] font-bold text-error">
                        {t("common", D.rejected)}
                      </span>
                    )}
                  </div>
                  {refusal && <p className="mt-1 text-[11px] font-bold text-error">{refusal}</p>}
                </div>
                {discount !== undefined && (
                  <span dir="ltr" className="mt-1 text-sm font-bold text-primary">
                    -{formatMoney(discount, BASE_CURRENCY, { lang, t })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(code)}
                  aria-label={t("common", D.remove, { code: key })}
                  className="flex size-8 shrink-0 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-error-bg hover:text-error"
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
