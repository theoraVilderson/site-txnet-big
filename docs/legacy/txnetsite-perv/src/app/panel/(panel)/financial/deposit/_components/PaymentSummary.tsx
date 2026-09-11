"use client";
import React from "react";
import {
  ChevronLeft,
  ShieldCheck,
  AlertCircle,
  Loader2,
  Receipt,
  Minus,
  Plus,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { formatCurrency } from "../../_util/format";
import { IAppliedCoupon } from "@/types/coupons";
import { toToman } from "@util/helper";
interface PaymentSummaryProps {
  amount: number | "";
  taxAmount: number;
  taxRate: number;
  feeAmount: number;
  appliedCoupons: IAppliedCoupon[];
  finalAmount: number;
  isValid: boolean;
  isMobileFooter?: boolean;
  onPay: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  isRedirecting?: boolean;
  isAdjusted?: boolean;
  adjustmentGap?: number;
}

const PaymentSummary: React.FC<PaymentSummaryProps> = ({
  amount,
  taxAmount,
  feeAmount,
  appliedCoupons,
  finalAmount,
  isValid,
  isMobileFooter = false,
  disabled = false,
  isLoading = false,
  isRedirecting = false,
  isAdjusted = false,
  taxRate = 0,
  adjustmentGap = 0,
  onPay,
}) => {
  const [showDetails, setShowDetails] = React.useState(false);
  const numAmount = typeof amount === "number" ? amount : 0;
  const totalDiscount = appliedCoupons.reduce((acc, c) => acc + c.amount, 0);
  const DetailsContent = () => (
    <div className="space-y-3 py-2">
      {isAdjusted && isValid && (
        <div className="mb-4 p-3 rounded-2xl bg-[var(--gold-bg)] border border-[var(--gold-primary)]/20 flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2">
          <Sparkles className="text-[var(--gold-primary)] shrink-0" size={18} />
          <p className="text-[11px] sm:text-xs font-bold text-[var(--gold-primary)] leading-relaxed">
            به دلیل محدودیت حداقل پرداخت درگاه، مبلغ نهایی به{" "}
            <span className="underline">
              {formatCurrency(toToman(finalAmount))} تومان
            </span>{" "}
            تعدیل شد. مبلغ{" "}
            <span className="font-black">
              {" "}
              اضافی{" "}
              <span className="underline">
                {formatCurrency(toToman(adjustmentGap))} تومان
              </span>{" "}
            </span>{" "}
            به صورت خودکار به شارژ کیف پول شما افزوده می‌شود.
          </p>
        </div>
      )}
      <div className="flex justify-between text-sm items-center">
        <span className="text-[var(--text-secondary)] font-medium text-xs">
          مبلغ شارژ کیف پول
        </span>
        <span className="text-[var(--text-primary)] font-black dir-ltr tracking-tight">
          {formatCurrency(toToman(numAmount))}
        </span>
      </div>

      <div className="flex justify-between text-sm items-center">
        <div className="flex items-center gap-1">
          <span className="text-[var(--text-secondary)] font-medium text-xs">
            مالیات {taxRate > 0 ? `(${taxRate}٪)` : "X"}
          </span>
          <Plus size={10} className="text-[var(--text-secondary)] opacity-50" />
        </div>

        {taxRate > 0 ? (
          <span className="text-[var(--text-secondary)] font-bold dir-ltr text-xs">
            {formatCurrency(toToman(taxAmount))}
          </span>
        ) : (
          <span className="text-[var(--accent-primary)] font-black text-[10px] bg-[var(--leaf-bg)] px-2 py-0.5 rounded-full">
            بدون مالیات
          </span>
        )}
      </div>

      <div className="flex justify-between text-sm items-center">
        <div className="flex items-center gap-1">
          <span className="text-[var(--text-secondary)] font-medium text-xs">
            کارمزد خدمات
          </span>
          <Plus size={10} className="text-[var(--text-secondary)] opacity-50" />
        </div>
        {feeAmount > 0 ? (
          <span className="text-[var(--text-secondary)] font-bold dir-ltr text-xs">
            {formatCurrency(toToman(feeAmount))}
          </span>
        ) : (
          <span className="text-[var(--accent-primary)] font-black text-[10px] bg-[var(--leaf-bg)] px-2 py-0.5 rounded-full">
            رایگان
          </span>
        )}
      </div>

      {appliedCoupons.map((coupon) => (
        <div
          key={coupon.code}
          className="flex justify-between text-sm items-center text-green-600 overflow-hidden"
        >
          <div className="flex items-center gap-1">
            <span className="font-bold text-xs truncate max-w-[180px]">
              تخفیف ({coupon.code})
            </span>
            <Minus size={10} className="opacity-50" />
          </div>
          <span className="font-black dir-ltr text-xs text-[var(--error-color)] ">
            - {formatCurrency(toToman(coupon.amount))}
          </span>
        </div>
      ))}

      <div className="border-t border-[var(--card-border)] flex flex-col text-sm  text-green-600 overflow-hidden">
        <div className=" pt-4  flex justify-between text-sm items-center text-green-600 overflow-hidden">
          <div className="flex items-center gap-1">
            <span className="font-bold text-xs truncate max-w-[180px]">
              جمع کل
            </span>
            <Minus size={10} className="opacity-50" />
          </div>
          <span className="font-black dir-ltr text-xs ">
            {formatCurrency(toToman(finalAmount + totalDiscount))}
          </span>
        </div>

        {!!appliedCoupons.length && (
          <div className=" pt-4  flex justify-between text-sm items-center text-green-600 overflow-hidden">
            <div className="flex items-center gap-1">
              <span className="font-bold text-xs truncate max-w-[180px]">
                جمع تخفیف ({appliedCoupons.length})
              </span>
              <Minus size={10} className="opacity-50" />
            </div>
            <span className="font-black dir-ltr text-xs text-[var(--error-color)] ">
              - {formatCurrency(toToman(totalDiscount))}
            </span>
          </div>
        )}
      </div>
      <div className="border-t border-dashed border-[var(--card-border)] my-2 opacity-50"></div>
    </div>
  );

  // ... داخل کامپوننت PaymentSummary

  const isFree = finalAmount === 0 && numAmount > 0;

  const PayButton = ({ fullWidth = false }) => (
    <>
      {isFree && (
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-100 rounded-xl p-3 mb-4">
          <ShieldCheck size={16} className="text-emerald-600" />
          <span className="text-[10px] font-bold text-emerald-700">
            مبلغ این تراکنش توسط کد تخفیف پوشش داده شد. شارژ به صورت آنی انجام
            می‌شود.
          </span>
        </div>
      )}
      <button
        disabled={!isValid || disabled || isLoading}
        onClick={onPay}
        className={`
          ${fullWidth ? "w-full" : "flex-1"}
          h-14 rounded-2xl font-black text-base flex items-center justify-center gap-2 transition-all duration-300 relative overflow-hidden
          ${
            // اولویت اول: حالت غیرفعال یا لودینگ
            !isValid || disabled || isLoading
              ? "bg-gray-100 text-gray-400 cursor-not-allowed" // استایل مشخص برای حالت غیرفعال
              : isFree
              ? // اولویت دوم: حالت رایگان (استفاده از رنگ‌های استاندارد تیلوایند برای اطمینان)
                "bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-200 active:scale-95"
              : // اولویت سوم: حالت عادی
                "bg-[var(--accent-primary)] text-white shadow-lg shadow-[var(--accent-glow)] hover:brightness-110 active:scale-95"
          }
        `}
      >
        {isRedirecting ? (
          <>
            <span className="text-sm">در حال انتقال</span>
            <Loader2 className="animate-spin" size={18} />
          </>
        ) : isLoading ? (
          <>
            <span className="text-sm">در حال محاسبه</span>
            <Loader2 className="animate-spin" size={18} />
          </>
        ) : (
          <>
            <span className="text-sm">
              {isFree
                ? "تایید و شارژ رایگان"
                : isMobileFooter
                ? "پرداخت"
                : "تایید و پرداخت"}
            </span>
            {isFree ? (
              <Sparkles size={18} strokeWidth={3} />
            ) : (
              <ChevronLeft size={18} strokeWidth={3} />
            )}
          </>
        )}
      </button>
    </>
  );

  if (isMobileFooter) {
    return (
      <div className="flex flex-col w-full">
        <div
          className="flex items-center justify-between mb-2 cursor-pointer active:opacity-70"
          onClick={() => setShowDetails(!showDetails)}
        >
          <span className="text-[10px] text-[var(--text-secondary)] font-bold flex items-center gap-1">
            <Receipt size={12} /> جزئیات صورتحساب
          </span>
          <div
            className={`transition-transform duration-300 ${
              showDetails ? "rotate-180" : ""
            }`}
          >
            <ChevronLeft
              size={14}
              className="rotate-90 text-[var(--text-secondary)]"
            />
          </div>
        </div>
        <AnimatePresence>
          {showDetails && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <DetailsContent />
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex items-center justify-between gap-4 h-16">
          <div className="flex flex-col">
            <span className="text-[9px] text-[var(--text-secondary)] font-bold mb-0.5">
              مبلغ قابل پرداخت
            </span>
            <div className="flex items-center gap-1 text-[var(--text-primary)]">
              <span className="text-xl font-black dir-ltr tracking-tight">
                {(!isLoading || isRedirecting) &&
                  formatCurrency(toToman(finalAmount))}
              </span>
              <span className="text-[9px] font-bold opacity-60">تومان</span>
            </div>
          </div>
          <PayButton />
        </div>
      </div>
    );
  }

  return (
    <div className="glass-panel rounded-[2rem] border border-[var(--card-border)] overflow-hidden flex flex-col shadow-xl">
      <div className="p-5 border-b border-[var(--card-border)] bg-[var(--bg-inner)]/30 flex items-center gap-2">
        <div className="p-2 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] rounded-xl">
          <Receipt size={20} />
        </div>
        <h3 className="font-black text-[var(--text-primary)] text-sm">
          صورتحساب نهایی
        </h3>
      </div>
      <div className="p-6">
        <DetailsContent />
        <div className="flex justify-between items-center mt-4 pt-4 border-t border-[var(--card-border)]">
          <span className="font-black text-[var(--text-primary)] text-base">
            جمع کل پرداختی
          </span>
          <div className="flex items-baseline gap-1">
            {isFree ? (
              <span className="text-xl font-black text-[var(--leaf-primary, #22c55e)] animate-pulse">
                رایگان!
              </span>
            ) : (
              <>
                <span className="text-2xl h-8 font-black text-[var(--gold-primary)] dir-ltr tracking-tighter drop-shadow-sm">
                  {(!isLoading || isRedirecting) &&
                    formatCurrency(toToman(finalAmount))}
                </span>
                <span className="text-[10px] text-[var(--text-secondary)] font-bold">
                  تومان
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-start gap-3 bg-[var(--error-bg)]/40 border border-[var(--error-border)]/10 rounded-2xl p-3 mt-4">
          <AlertCircle
            size={14}
            className="text-[var(--error-color)] shrink-0 mt-0.5"
          />
          <p className="text-[10px] text-[var(--error-color)] leading-relaxed font-black">
            هشدار: مبالغ واریزی نهایی بوده و امکان استرداد وجه وجود ندارد.
          </p>
        </div>
        <div className="mt-6">
          <PayButton fullWidth={true} />
        </div>
      </div>
    </div>
  );
};

export default PaymentSummary;
