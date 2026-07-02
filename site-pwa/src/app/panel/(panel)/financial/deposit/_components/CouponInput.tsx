import React, { useRef, useState } from "react";
import {
  Ticket,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowLeft,
  Plus,
  Trash2,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { CouponValidationResult } from "../_types/type";
import { IAppliedCoupon, MultipleCouponResult } from "@/types/coupons";
import { toToman } from "@util/helper";

interface CouponManagerProps {
  appliedCoupons: IAppliedCoupon[];
  onAddCoupon: (coupon: IAppliedCoupon) => void;
  onRemoveCoupon: (code: string) => void;
  validateCoupon: (codes: string[]) => Promise<MultipleCouponResult | null>;
  disabled?: boolean;
}

const CouponManager: React.FC<CouponManagerProps> = ({
  appliedCoupons,
  onAddCoupon,
  onRemoveCoupon,
  validateCoupon,
  disabled,
}) => {
  disabled = disabled || false;
  const [inputValue, setInputValue] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [msg, setMsg] = useState("");
  const submitLockRef = useRef(false);
  const handleSubmit = async () => {
    if (submitLockRef.current) return;
    if (!inputValue.trim()) return;

    submitLockRef.current = true; // 🔒 قفل فوری

    // Check if already exists
    if (
      appliedCoupons.some(
        (c) => c.code.toLowerCase() === inputValue.toLowerCase()
      )
    ) {
      setStatus("error");
      setMsg("این کد قبلاً اعمال شده است");
      submitLockRef.current = false; // 🔓 آزاد
      return;
    }

    setStatus("loading");
    setMsg("");

    try {
      // به جای لاین ۴۷، این را بنویسید:
    const allCodesToValidate = [...appliedCoupons.map((c) => c.code), inputValue];
    const result = await validateCoupon(allCodesToValidate);

      if (!result) throw new Error("خطا در خواندن کد تخفیف");

      if (result.isValid && result.totalDiscount) {
        setStatus("success");
        setMsg("کد تخفیف اعمال شد");

        onAddCoupon({
          ...result.appliedCoupons[0],
          description: result.appliedCoupons[0].description || "تخفیف ویژه",
        });

        setInputValue("");

        setTimeout(() => {
          setStatus("idle");
          setMsg("");
        }, 2000);
      } else {
        setStatus("error");
        setMsg(result.errors.join("/") || "کد نامعتبر است");
      }
    } catch {
      setStatus("error");
      setMsg("خطا در بررسی کد تخفیف");
    } finally {
      submitLockRef.current = false; // 🔓 آزادسازی تضمینی
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit();
    }
  };

  return (
    <div className="w-full max-w-md mx-auto">
      {/* --- Input Section --- */}
      <div className="glass-panel p-6 rounded-[1.5rem] border border-[var(--card-border)] shadow-[0_8px_32px_var(--card-shadow)] relative overflow-hidden transition-all duration-300">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-2 rounded-full bg-[var(--leaf-bg)] text-[var(--accent-primary)]">
            <Ticket size={20} />
          </div>
          <label className="text-sm font-bold text-[var(--text-primary)]">
            کد تخفیف دارید؟
          </label>
        </div>

        <div className="relative flex items-center">
          <input
            type="text"
            disabled={disabled}
            value={inputValue}
            onKeyDown={handleKeyDown}
            onChange={(e) => {
              setInputValue(e.target.value);
              if (status === "error" || status === "success") {
                setStatus("idle");
                setMsg("");
              }
            }}
            placeholder="بنویسید (مثلاً: SPRING1403)"
            className={`
              w-full bg-[var(--bg-inner)] rounded-2xl border-2 px-4 py-3.5 pl-12 text-sm font-bold text-[var(--text-primary)] focus:outline-none transition-all placeholder:text-[var(--text-secondary)]/70
              ${
                status === "error"
                  ? "border-[var(--error-color)] bg-[var(--error-bg)]/10"
                  : status === "success"
                  ? "border-[var(--success-color)] bg-[var(--success-bg)]/10"
                  : "border-[var(--card-border)] focus:border-[var(--accent-primary)] focus:shadow-[0_0_0_4px_var(--leaf-bg)]"
              }
            `}
          />

          <div className="absolute left-2 top-1/2 -translate-y-1/2">
            <AnimatePresence mode="wait">
              {status === "loading" ? (
                <motion.div
                  key="loader"
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                >
                  <Loader2
                    className="animate-spin text-[var(--text-secondary)]"
                    size={20}
                  />
                </motion.div>
              ) : (
                <motion.button
                  key="apply"
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  disabled={!inputValue}
                  onClick={handleSubmit}
                  className={`
                    h-8 px-3 rounded-xl transition-all flex items-center justify-center gap-1 shadow-md
                    ${
                      inputValue
                        ? "bg-[var(--accent-primary)] text-white shadow-[var(--accent-glow)] cursor-pointer"
                        : "bg-[var(--bg-inner)] text-[var(--text-secondary)] opacity-50 cursor-not-allowed border border-[var(--card-border)]"
                    }
                  `}
                >
                  {status === "error" ? (
                    <span className="flex items-center">
                      <ArrowLeft size={16} />
                    </span>
                  ) : (
                    <>
                      <span className="text-[11px] font-black">ثبت</span>
                      <Plus size={12} strokeWidth={4} />
                    </>
                  )}
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Inline Feedback Message */}
        <AnimatePresence>
          {status !== "idle" && status !== "loading" && msg && (
            <motion.div
              initial={{ opacity: 0, y: -10, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -10, height: 0 }}
              className={`flex items-center gap-1.5 mt-3 text-xs font-bold overflow-hidden ${
                status === "success"
                  ? "text-[var(--success-color)]"
                  : "text-[var(--error-color)]"
              }`}
            >
              {status === "success" ? (
                <CheckCircle2 size={14} />
              ) : (
                <XCircle size={14} />
              )}
              {msg}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* --- Active Coupons List --- */}
      <div className="mt-6 space-y-3">
        <AnimatePresence>
          {appliedCoupons.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center justify-between px-2 mb-2"
            >
              <span className="text-xs font-bold text-[var(--text-secondary)]">
                کدهای فعال ({appliedCoupons.length})
              </span>
            </motion.div>
          )}
          {appliedCoupons.map((coupon) => (
            <motion.div
              key={coupon.code}
              initial={{ opacity: 0, x: 20, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -20, scale: 0.9 }}
              layout
              className="group relative flex items-center justify-between p-4 rounded-2xl border border-[var(--card-border)] bg-[var(--bg-inner)] overflow-hidden"
            >
              {/* Decorative Background Element */}
              <div className="absolute top-0 right-0 w-16 h-full bg-gradient-to-l from-[var(--leaf-bg)] to-transparent opacity-50" />

              <div className="flex items-center gap-3 relative z-10">
                <div className="w-10 h-10 rounded-full bg-[var(--gold-bg)] flex items-center justify-center text-[var(--gold-primary)] border border-[var(--gold-glow)] shadow-[0_0_15px_var(--gold-bg)]">
                  <Sparkles size={18} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-black text-[var(--text-primary)] tracking-wide">
                      {coupon.code.toUpperCase()}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--success-bg)] text-[var(--success-color)] font-bold">
                      فعال
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                    {coupon.description}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-4 relative z-10">
                <span className="text-sm font-black text-[var(--accent-primary)] dir-ltr">
                  - ${toToman(coupon.amount).toLocaleString()}
                </span>
                <button
                  onClick={() => onRemoveCoupon(coupon.code)}
                  className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--error-bg)] hover:text-[var(--error-color)] hover:border-[var(--error-border)] transition-all"
                  title="حذف کد"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default CouponManager;
