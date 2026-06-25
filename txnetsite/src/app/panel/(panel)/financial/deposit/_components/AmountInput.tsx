"use client";
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowUpRight, ShieldCheck, Coins } from "lucide-react";
import { formatCurrency, numberToPersianWords } from "../../_util/format";
import { PRESET_AMOUNTS, SLIDER_MAX_AMOUNT } from "../_util/constants";
import { ABSOLUTE_MAX_AMOUNT, MIN_AMOUNT } from "@/configs/payments";
import { toToman } from "@util/helper";

interface AmountInputProps {
  amount: number | "";
  onAmountChange: (val: number | "") => void;
  disabled?: boolean;
  min: number;
  max: number;
}

const AmountInput: React.FC<AmountInputProps> = ({
  amount,
  onAmountChange,
  disabled = false,
  min = MIN_AMOUNT,
  max = ABSOLUTE_MAX_AMOUNT,
}) => {
  const [isFocused, setIsFocused] = React.useState(false);
  const numAmount = typeof amount === "number" ? amount : 0;

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/[^0-9]/g, "");
    if (!val) {
      onAmountChange("");
    } else {
      const numericVal = Math.min(Number(val), ABSOLUTE_MAX_AMOUNT);
      onAmountChange(numericVal);
    }
  };

  const sliderValue = Math.min(numAmount, SLIDER_MAX_AMOUNT);
  return (
    <div className="glass-panel p-6 sm:p-7 rounded-[2rem] border border-[var(--card-border)] relative overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md">
      <div className="absolute top-0 right-0 w-32 h-32 bg-[var(--gold-primary)] opacity-5 blur-[80px] pointer-events-none"></div>

      <div className="flex items-center gap-2 mb-4">
        <Coins size={16} className="text-[var(--gold-primary)]" />
        <label className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
          تعیین مبلغ شارژ (تومان)
        </label>
      </div>

      {/* Primary Input Container */}
      <div
        className={`
        relative flex items-center bg-[var(--bg-inner)] rounded-2xl border-2 transition-all duration-500 px-4 py-4
        ${
          isFocused
            ? "border-[var(--gold-primary)] shadow-[0_0_30px_var(--gold-glow)] ring-4 ring-[var(--gold-bg)]"
            : "border-[var(--card-border)]"
        }
      `}
      >
        <span className="text-[var(--text-secondary)] text-sm md:text-lg ml-3 opacity-40 font-black">
          {!amount && "IRT"}
        </span>
        <input
          disabled={disabled}
          type="text"
          min={min}
          max={max}
          inputMode="numeric"
          value={amount ? amount.toLocaleString("en-US") : ""}
          onChange={handleInputChange}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder="0"
          className="w-full bg-transparent text-2xl md:text-4xl font-black text-[var(--text-primary)] focus:outline-none dir-ltr font-sans placeholder:text-[var(--text-secondary)]/10"
        />
        <AnimatePresence>
          {amount && (
            <motion.div
              initial={{ scale: 0, rotate: -45 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--gold-primary)]"
            >
              <ArrowUpRight size={24} className="drop-shadow-sm" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Amount in Persian Words */}
      <div className="min-h-[40px] mt-3 flex items-center">
        <AnimatePresence mode="wait">
          {numAmount > 0 && (
            <motion.div
              key={numAmount}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              className="text-[11px] md:text-xs font-black text-[var(--gold-primary)] bg-[var(--gold-bg)] px-4 py-2 rounded-xl border border-[var(--gold-primary)]/10 shadow-sm"
            >
              {numberToPersianWords(numAmount)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Presets Grid */}
      <div className="grid grid-cols-3 gap-3 mt-4">
        {PRESET_AMOUNTS.map((preset) => (
          <button
            key={preset}
            disabled={disabled}
            onClick={() => onAmountChange(preset)}
            className={`
              relative overflow-hidden py-3 px-2 rounded-2xl border text-[11px] md:text-sm font-black transition-all duration-300
              ${
                amount === preset
                  ? "border-[var(--gold-primary)] bg-[var(--gold-primary)] text-white shadow-lg scale-[1.03]"
                  : "border-[var(--card-border)] bg-[var(--bg-inner)]/50 text-[var(--text-secondary)] hover:border-[var(--text-primary)] active:scale-95"
              }
            `}
          >
            <span className="relative z-10 dir-ltr block">
              {formatCurrency(preset)}
            </span>
            {amount === preset && (
              <motion.div
                layoutId="activePreset"
                className="absolute inset-0 bg-white/10"
              />
            )}
          </button>
        ))}
      </div>

      {/* Custom Range Slider (RTL Mode) */}
      <div className="mt-10 mb-2 px-1 relative group dir-rtl">
        <input
          type="range"
          dir="rtl"
          disabled={disabled}
          min={min}
          max={max}
          step={10000}
          value={sliderValue || 0}
          onChange={(e) => onAmountChange(Number(e.target.value))}
          className="range-slider cursor-pointer"
        />

        <div className="flex justify-between mt-4 text-[10px] text-[var(--text-secondary)] font-bold opacity-60">
          {/* In RTL: First child is on the RIGHT side (Minimum) */}
          <div className="flex flex-col items-start gap-1">
            <span className="bg-[var(--leaf-bg)] px-2 py-0.5 rounded-full">
              {formatCurrency(min)}
            </span>
            <span className="text-[8px] uppercase tracking-tighter">حداقل</span>
          </div>
          <div className="flex flex-col items-center">
            <div className="w-1 h-1 rounded-full bg-[var(--card-border)] mb-1"></div>
            <span>{formatCurrency(SLIDER_MAX_AMOUNT / 2)}</span>
          </div>
          {/* In RTL: Last child is on the LEFT side (Maximum) */}
          <div className="flex flex-col items-end gap-1">
            <span className="bg-[var(--leaf-bg)] px-2 py-0.5 rounded-full">
              {formatCurrency(SLIDER_MAX_AMOUNT)}
            </span>
            <span className="text-[8px] uppercase tracking-tighter">
              حداکثر
            </span>
          </div>
        </div>
      </div>

      {/* Validation Messages */}
      <div className="h-6 mt-4">
        <AnimatePresence>
          {numAmount > 0 && numAmount < min && (
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[10px] text-[var(--error-color)] flex items-center gap-1.5 font-bold"
            >
              <ShieldCheck size={12} /> حداقل شارژ مجاز{" "}
              {formatCurrency(toToman(min))} تومان می‌باشد.
            </motion.p>
          )}
          {numAmount >= max && (
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[10px] text-[var(--gold-primary)] flex items-center gap-1.5 font-bold"
            >
              <ShieldCheck size={12} /> سقف شارژ مجاز{" "}
              {formatCurrency(toToman(max))} تومان می‌باشد.
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default AmountInput;
