"use client";

import { useId, useState } from "react";
import { Coins } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { DepositGateway } from "@/lib/billing-api";
import { toEnglishDigits } from "@/util/helper";
import { amountInWords, formatMoney } from "../../../_lib/money";
import { fromCents, offeredPresets, toCents } from "../_lib/deposit-amount";

const D = FrontendI18nKeys.common.deposit.amount;

interface AmountInputProps {
  /** Exactly what is in the box, as typed. `""` while empty. */
  amount: string;
  onAmountChange: (amount: string) => void;
  /** Its `minAmount` / `maxAmount` are the bounds, the presets and the slider's range. */
  gateway: DepositGateway | null;
  /** What the amount is in: the gateway's, else the wallet's; `null` until either is known (F-116-h3). */
  currency: string | null;
  disabled?: boolean;
}

/**
 * What the box will accept: digits, one separator, at most two places. A
 * trailing `.` survives so a user can type `10.` on the way to `10.50` — the
 * value is only ever *read* through `toCents`, which refuses it.
 */
const TYPING = /^\d{0,16}(\.\d{0,2})?$/;

/**
 * The amount box (F-093-e): a number, the same number in words, the gateway's
 * own presets, and a slider across its range.
 *
 * **Persian digits are accepted and stored as ASCII.** A `fa` user types `۱۰۰`
 * and the wire gets `100.00` — the regex the deposit route validates against
 * takes ASCII only, so converting at the boundary is the difference between a
 * working box and an unexplained 400.
 *
 * The bounds are the **gateway's**, not a constant: legacy kept six rial
 * figures and a two-million slider ceiling in `_util/constants.ts`, which is
 * one tenant's pricing decision compiled into the app. Here they come from
 * `GET /deposit/gateways`, so they move when the tenant moves them
 * (`deposit-amount.ts`).
 */
export function AmountInput({ amount, onAmountChange, gateway, currency, disabled }: AmountInputProps) {
  const { lang, t } = useLocale();
  const [focused, setFocused] = useState(false);
  const inputId = useId();

  const money = (value: string) => formatMoney(value, currency ?? "", { lang, t });
  const words = currency ? amountInWords(amount, currency, { lang, t }) : null;

  const cents = toCents(amount);
  // A bound the gateway left open is `null`: no check on that side, and no slider without both.
  const min = gateway?.minAmount ? toCents(gateway.minAmount) : null;
  const max = gateway?.maxAmount ? toCents(gateway.maxAmount) : null;
  const presets = gateway ? offeredPresets(gateway) : [];

  // A hundred stops across whatever range this gateway takes. A slider is a
  // coarse control; the box beside it is how an exact figure gets typed.
  const sliderMax = max ?? 0;
  const sliderStep = Math.max(1, Math.floor(((max ?? 0) - (min ?? 0)) / 100));

  function handleTyped(raw: string) {
    const next = toEnglishDigits(raw).replace(/[٫,\s]/g, "").replace(/^\./, "0.");
    if (next === "" || TYPING.test(next)) onAmountChange(next);
  }

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <Coins size={16} className="text-primary" aria-hidden />
        <label htmlFor={inputId} className="text-sm font-bold text-text-primary">
          {t("common", D.label)}
        </label>
      </div>

      <div
        className={`flex items-center rounded-2xl border-2 bg-bg-inner px-4 py-3 transition-colors ${
          focused ? "border-primary" : "border-card-border"
        }`}
      >
        <span className="me-3 shrink-0 text-sm font-bold text-text-secondary opacity-50">
          {currency}
        </span>
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          disabled={disabled}
          value={amount}
          placeholder={t("common", D.placeholder)}
          onChange={(e) => handleTyped(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="w-full bg-transparent text-2xl font-bold text-text-primary outline-none placeholder:text-text-secondary/30 md:text-3xl"
        />
      </div>

      {/* The figure in words, hidden when the locale has no words for it
          (`contract.kit.md` rule 4) rather than printed as a gap. */}
      <p className="mt-3 min-h-[1.75rem] text-xs font-bold text-primary">{words}</p>

      {presets.length > 0 && (
        <div
          role="group"
          aria-label={t("common", D.presets)}
          className="mt-2 grid grid-cols-3 gap-2"
        >
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={disabled}
              aria-pressed={cents !== null && cents === toCents(preset)}
              onClick={() => onAmountChange(preset)}
              className={`rounded-xl border px-2 py-2.5 text-xs font-bold transition-colors ${
                cents !== null && cents === toCents(preset)
                  ? "border-primary bg-primary text-white"
                  : "border-card-border bg-bg-inner text-text-secondary hover:border-text-primary"
              }`}
            >
              <span dir="ltr">{money(preset)}</span>
            </button>
          ))}
        </div>
      )}

      {min !== null && max !== null && max > min && (
        <div className="mt-6">
          <input
            type="range"
            aria-label={t("common", D.slider)}
            disabled={disabled}
            min={min}
            max={sliderMax}
            step={sliderStep}
            value={Math.min(Math.max(cents ?? min, min), sliderMax)}
            onChange={(e) => onAmountChange(fromCents(Number(e.target.value)))}
            className="range-slider"
          />
          <div className="mt-3 flex justify-between text-[10px] font-bold text-text-secondary">
            <span>{t("common", D.min, { amount: money(fromCents(min)) })}</span>
            <span>{t("common", D.max, { amount: money(fromCents(max)) })}</span>
          </div>
        </div>
      )}

      {/* The gateway refuses these itself with a 400; saying so here saves the
          user a round trip, and the server is still the one that decides. */}
      <p className="mt-3 min-h-[1.25rem] text-[11px] font-bold text-error" role="status">
        {cents !== null && min !== null && cents > 0 && cents < min
          ? t("common", D.belowMin, { amount: money(fromCents(min)) })
          : cents !== null && max !== null && cents > max
            ? t("common", D.aboveMax, { amount: money(fromCents(max)) })
            : ""}
      </p>
    </section>
  );
}
