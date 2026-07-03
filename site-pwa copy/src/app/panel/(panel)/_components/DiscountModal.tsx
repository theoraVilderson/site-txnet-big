import React, { useState, useRef, useEffect } from "react";
import {
  X,
  Ticket,
  Loader2,
  Check,
  Sparkles,
  AlertCircle,
  Trash2,
} from "lucide-react";
import { handleAxiosError, req } from "@lib/request";
import axios from "axios";
import { useAuthStore } from "../_stores/useAuthStore";
import type { ResponseType } from "@/shared";

export interface VaultState {
  isValutOpen: boolean;
  setIsValutOpen: (open: boolean) => void;
  balance: number;
}

export enum DiscountStatus {
  IDLE = "IDLE",
  LOADING = "LOADING",
  SUCCESS = "SUCCESS",
  ERROR = "ERROR",
}

interface DiscountModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DiscountModal({ isOpen, onClose }: DiscountModalProps) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<DiscountStatus>(DiscountStatus.IDLE);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const [isRendered, setIsRendered] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const userValutBalance = useAuthStore((s) => s.user!.walletBalance);
  const updateUser = useAuthStore((s) => s.updateUser);

  useEffect(() => {
    if (isOpen) {
      setIsRendered(true);
      const timer = setTimeout(() => {
        setIsVisible(true);
        inputRef.current?.focus();
      }, 10);
      return () => clearTimeout(timer);
    } else {
      setIsVisible(false);
      const timer = setTimeout(() => {
        setIsRendered(false);
        setStatus(DiscountStatus.IDLE);
        setCode("");
        setError("");
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || status === DiscountStatus.LOADING) return;

    setStatus(DiscountStatus.LOADING);

    try {
      const url = `/gift`;
      const res = await req.post<ResponseType<{ amount: number }>>(url, {
        giftCode: code, // مبلغ شارژ کیف پول
      });

      const data = res.data;
      if (!data.ok) {
        setError("این کد معتبر نیست یا منقضی شده است.");
        setStatus(DiscountStatus.ERROR);
        setTimeout(() => {
          if (status !== DiscountStatus.SUCCESS) setStatus(DiscountStatus.IDLE);
        }, 3000);
      } else {
        updateUser({ walletBalance: userValutBalance + data.data.amount });
        setStatus(DiscountStatus.SUCCESS);
        setTimeout(() => onClose(), 2000);
      }
    } catch (e: any) {
      if (axios.isCancel(e) || e.name === "CanceledError") return;
      setError(handleAxiosError(e, "خطا در بررسی و اعمال کد هدیه").message);
      setStatus(DiscountStatus.ERROR);
      setTimeout(() => {
        if (status !== DiscountStatus.SUCCESS) setStatus(DiscountStatus.IDLE);
      }, 3000);
    }
  };

  if (!isRendered) return null;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center p-4 overflow-hidden">
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-md transition-opacity duration-500 ease-out ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />

      <div
        className={`
        relative w-full max-w-md glass rounded-[2.5rem] overflow-hidden
        transition-all duration-500 cubic-bezier(0.34, 1.56, 0.64, 1) transform
        ${
          isVisible
            ? "scale-100 opacity-100 translate-y-0"
            : "scale-90 opacity-0 translate-y-12"
        }
      `}
      >
        {/* Animated Background Orbs */}
        <div className="absolute -top-20 -right-20 w-48 h-48 bg-[var(--accent-primary)]/20 rounded-full blur-[80px] pointer-events-none animate-pulse" />
        <div className="absolute -bottom-20 -left-20 w-48 h-48 bg-[var(--gold-primary)]/15 rounded-full blur-[80px] pointer-events-none animate-pulse" />

        <div className="p-8 md:p-10 relative">
          <div className="flex justify-between items-start mb-10">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="absolute inset-0 bg-[var(--accent-primary)]/20 blur-xl rounded-full" />
                <div
                  className={`
                  w-14 h-14 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-emerald-700 flex items-center justify-center text-white shadow-xl
                  transition-transform duration-700 delay-200
                  ${
                    isVisible
                      ? "rotate-0 scale-100"
                      : "rotate-[-30deg] scale-50"
                  }
                `}
                >
                  <Ticket size={28} />
                </div>
              </div>
              <div
                className={`transition-all duration-500 delay-150 ${
                  isVisible
                    ? "translate-x-0 opacity-100"
                    : "translate-x-6 opacity-0"
                }`}
              >
                <h3 className="text-2xl font-black text-white tracking-tight">
                  کد هدیه
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-1 font-medium">
                  افزایش اعتبار با کدهای تخفیف
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-3 rounded-2xl hover:bg-white/10 text-[var(--text-secondary)] transition-all hover:rotate-90 active:scale-90 border border-transparent hover:border-white/20"
            >
              <X size={24} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* --- IMPROVED INPUT SECTION --- */}
            <div className="relative group">
              <label className="block text-[10px] font-black text-[var(--text-secondary)] mb-2 mr-1 uppercase tracking-widest opacity-70">
                کد اختصاصی شما
              </label>
              <div className="relative flex items-center">
                <input
                  ref={inputRef}
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="مثلاً: TEXNET-2024"
                  disabled={
                    status === DiscountStatus.LOADING ||
                    status === DiscountStatus.SUCCESS
                  }
                  className={`
                    w-full bg-[var(--bg-inner)] border-2 rounded-2xl px-6 py-5 text-center text-2xl font-black tracking-[0.15em] font-mono
                    outline-none transition-all duration-500 placeholder:text-[var(--text-secondary)]/20 placeholder:tracking-normal placeholder:font-sans
                    ${
                      status === DiscountStatus.ERROR
                        ? "border-[var(--error-color)] text-[var(--error-color)] shadow-inner"
                        : status === DiscountStatus.SUCCESS
                          ? "border-[var(--accent-primary)] text-[var(--accent-primary)] shadow-inner"
                          : "border-[var(--card-border)] focus:border-[var(--accent-primary)] text-[var(--text-primary)] focus:shadow-[0_0_30px_rgba(76,175,80,0.15)] focus:bg-white/50"
                    }
                  `}
                />

                {/* Clear Button */}
                {code && status === DiscountStatus.IDLE && (
                  <button
                    type="button"
                    onClick={() => {
                      setCode("");
                      inputRef.current?.focus();
                    }}
                    className="absolute left-4 p-2 text-[var(--text-secondary)]/40 hover:text-[var(--error-color)] transition-colors"
                  >
                    <Trash2 size={18} />
                  </button>
                )}

                {/* Status Icons inside Input */}
                <div className="absolute right-4 flex items-center pointer-events-none">
                  {status === DiscountStatus.SUCCESS && (
                    <Sparkles
                      size={24}
                      className="text-[var(--accent-primary)] animate-bounce"
                    />
                  )}
                  {status === DiscountStatus.ERROR && (
                    <AlertCircle
                      size={24}
                      className="text-[var(--error-color)] animate-shake"
                    />
                  )}
                </div>
              </div>

              {/* Animated bottom line focus indicator */}
              <div
                className={`absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 bg-[var(--accent-primary)] transition-all duration-500 rounded-full ${
                  status === DiscountStatus.IDLE
                    ? "w-0 group-focus-within:w-[80%]"
                    : "w-0"
                }`}
              />
            </div>

            {/* Error Message with Slide Animation */}
            <div
              className={`transition-all duration-300 overflow-hidden ${
                status === DiscountStatus.ERROR
                  ? "max-h-20 opacity-100"
                  : "max-h-0 opacity-0"
              }`}
            >
              <div className="flex items-center gap-3 text-[var(--error-color)] bg-[var(--error-bg)] p-4 rounded-2xl border border-[var(--error-border)] shadow-sm">
                <AlertCircle size={18} className="shrink-0" />
                <span className="text-xs font-black leading-relaxed">
                  {error}
                </span>
              </div>
            </div>

            {/* --- BEAUTIFUL ACTIVATION BUTTON --- */}
            <button
              type="submit"
              disabled={
                !code.trim() ||
                status === DiscountStatus.LOADING ||
                status === DiscountStatus.SUCCESS
              }
              className={`
                w-full py-5 rounded-2xl font-black text-white shadow-2xl transition-all duration-500 active:scale-[0.96]
                flex items-center justify-center gap-3 text-lg relative overflow-hidden group/btn
                ${
                  status === DiscountStatus.SUCCESS
                    ? "bg-gradient-to-r from-emerald-500 to-green-600 shadow-emerald-500/40"
                    : status === DiscountStatus.ERROR
                      ? "bg-gradient-to-r from-orange-500 to-red-600 shadow-orange-500/40"
                      : "bg-gradient-to-r from-[var(--accent-primary)] to-emerald-700 hover:brightness-110 shadow-[var(--accent-glow)]"
                }
                disabled:opacity-40 disabled:grayscale disabled:cursor-not-allowed
              `}
            >
              {status === DiscountStatus.LOADING ? (
                <div className="flex items-center gap-3">
                  <Loader2 size={24} className="animate-spin" />
                  <span className="animate-pulse tracking-wide">
                    بررسی اصالت کد...
                  </span>
                </div>
              ) : status === DiscountStatus.SUCCESS ? (
                <div className="flex items-center gap-3">
                  <Check
                    size={26}
                    className="animate-in zoom-in duration-500"
                  />
                  <span className="translate-y-px">هدیه با موفقیت فعال شد</span>
                </div>
              ) : (
                <span className="tracking-wide">فعال‌سازی و شارژ آنی</span>
              )}

              {/* Button Shine Sweep */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent -translate-x-full group-hover/btn:translate-x-full transition-transform duration-1000 ease-in-out" />
            </button>
          </form>

          {/* Footer Info */}
          <div className="mt-10 pt-8 border-t border-[var(--card-border)]/50">
            <div className="flex items-center justify-center gap-4 text-[var(--text-secondary)] opacity-80 hover:opacity-100 transition-opacity">
              <div className="w-1 h-1 rounded-full bg-current" />
              <p className="text-[10px] font-bold text-center">
                پشتیبانی ۲۴ ساعته تکسنت برای مشکلات پرداخت
              </p>
              <div className="w-1 h-1 rounded-full bg-current" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
