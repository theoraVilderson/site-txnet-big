"use client";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Sparkles, Wallet as WalletIcon, ShieldCheck } from "lucide-react";
import AmountInput from "./AmountInput";
import GatewaySelector from "./GatewaySelector";
import WalletPreview from "./WalletPreview";
import PaymentSummary from "./PaymentSummary";
import CouponInput from "./CouponInput";
import { useAuthStore } from "@app/panel/(panel)/_stores/useAuthStore";
import {
  PaymentProvider,
  FeeMode,
  FeeType,
  FeeCurrency,
} from "@/configs/paymentSettings";
import {
  ABSOLUTE_MAX_AMOUNT,
  MIN_AMOUNT,
} from "@/configs/payments";
import { formatCurrency } from "../../_util/format";
import { IPaymentSettingClient } from "@/types/paymentSetting";
import "./Deposit.css";
import { IAppliedCoupon, MultipleCouponResult } from "@/types/coupons";
import { handleAxiosError, req } from "@lib/request";
import { SendResType } from "@/shared";
import axios from "axios";
import { toToman } from "@util/helper";
import { calculatePaymentAmount } from "@lib/payment/fee/feeAndTaxCalculator";
interface DepositProps {
  paymentSettings: IPaymentSettingClient[];
  paymentBaseURL: string;
}

export default function Deposit({
  paymentSettings,
  paymentBaseURL,
}: DepositProps) {
  const noPaymentPorviders = !paymentSettings.length;
  const CURRENT_BALANCE = useAuthStore((s) => s.user!.walletBalance);

  // --- States ---
  const [amount, setAmount] = useState<number | "">("");
  const [appliedCoupons, setAppliedCoupons] = useState<IAppliedCoupon[]>([]);
  const [selectedGateway, setSelectedGateway] = useState<PaymentProvider | "">(
    paymentSettings[0]?.gatewayName ?? ""
  );

  // Fee & Loading States
  const [feeAmount, setFeeAmount] = useState<number>(0);
  const [isFeeLoading, setIsFeeLoading] = useState<boolean>(false);
  const [isCouponLoading, setIsCouponLoading] = useState<boolean>(false);
  const [paymentURLLoading, setPaymentURLLoading] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const loading = isFeeLoading || isCouponLoading || paymentURLLoading;

  // Scroll Effect
  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // --- Base Values ---
  const numAmount = typeof amount === "number" ? amount * 10 : 0; // تبدیل تومان به ریال (اگر ورودی تومان است)

  // پیدا کردن تنظیمات درگاه انتخاب شده
  const currentProvider = useMemo(() => {
    if (!selectedGateway) return null;
    return (
      paymentSettings.find((e) => e.gatewayName === selectedGateway) ?? null
    );
  }, [selectedGateway]);



  // ... داخل کامپوننت Deposit:

  // ۱. ضریب تبدیل: اگر درگاه تومان بود ضربدر ۱۰ می‌شود، در غیر این صورت (ریال) ضربدر ۱
  const currencyMultiplier = currentProvider?.feeConfig.currency === FeeCurrency.IRT ? 10 : 1;

  // ۲. حالا مطمئنیم که این دو متغیر همیشه و تحت هر شرایطی "ریال" خالص هستند
  const MIN_AMOUNT_GATEWAY = currentProvider?.minAmountAccept 
    ? currentProvider.minAmountAccept * currencyMultiplier 
    : MIN_AMOUNT;

  const MAX_AMOUNT_GATEWAY = currentProvider?.maxAmountAccept 
    ? currentProvider.maxAmountAccept * currencyMultiplier 
    : ABSOLUTE_MAX_AMOUNT;


  // ۳. اعتبار سنجی دکمه پرداخت (مقایسه ریال با ریال)
  const isValid = numAmount >= MIN_AMOUNT_GATEWAY && numAmount <= MAX_AMOUNT_GATEWAY;

  // --- 1. Logic: Discount & Base Payable Calculation ---

  // مجموع تخفیف کوپن‌ها
  const totalDiscount = appliedCoupons.reduce((acc, c) => acc + c.amount, 0);

  // مبلغ خالص اولیه (مبلغ درخواستی منهای تخفیف)
  // مثال: درخواست ۱۰۰ تومن، ۲۰ تومن تخفیف -> ۸۰ تومن
  let calculatedBasePayable = Math.max(0, numAmount - totalDiscount);

  // --- 2. Logic: Smart Adjustment (Adjustment Gap) ---

  let adjustmentGap = 0;
  let isAdjusted = false;

  // اگر مبلغ خالص محاسبه شده بیشتر از صفر است اما کمتر از کف درگاه
  // باید مبلغ را به کف درگاه برسانیم.
  if (
    calculatedBasePayable > 0 &&
    currentProvider &&
    calculatedBasePayable < MIN_AMOUNT_GATEWAY
  ) {
    adjustmentGap = MIN_AMOUNT_GATEWAY - calculatedBasePayable;
    calculatedBasePayable = MIN_AMOUNT_GATEWAY;
    isAdjusted = true;
  }

  // این متغیر `calculatedBasePayable` اکنون مبلغی است که باید به درگاه برود (بدون مالیات و کارمزد)
  // و مبنای محاسبه مالیات و کارمزد قرار می‌گیرد.

  // --- 3. Logic: Fee Calculation (Effect) ---

  useEffect(() => {
    // اگر مبلغ پایه‌ای وجود ندارد یا درگاه انتخاب نشده، کارمزد ۰ است
    if (!calculatedBasePayable || !currentProvider) {
      setFeeAmount(0);
      return;
    }

    const { feeConfig } = currentProvider;
    setIsFeeLoading(true);

    // سناریو 1: محاسبه دستی (Client-Side)
    if (feeConfig.mode === FeeMode.MANUAL) {
      let calc = 0;
      // نکته مهم: محاسبه کارمزد بر اساس calculatedBasePayable (مبلغ خالص) انجام می‌شود
      calculatePaymentAmount(calculatedBasePayable, currentProvider)
        .then((r) => {
          calc = r.feeAmount;
          setFeeAmount(Math.floor(calc));
        })
        .catch((e) => {
          console.error(e);
          setFeeAmount(Math.floor(calc));
        })
        .finally(() => {
          setIsFeeLoading(false);
        });
    }

    // سناریو 2: محاسبه از طریق API
    else if (feeConfig.mode === FeeMode.API) {
      const debounceTimer = setTimeout(async () => {
        try {
          const res = await req.post("deposit/payment/fee/calc", {
            amount: calculatedBasePayable, // ارسال مبلغ خالص
            gatewayName: selectedGateway,
          });

          if (res.data.status === "ok") {
            setFeeAmount(res.data.data.feeAmount);
          } else {
            console.error(res.data.msg);
            setFeeAmount(0);
          }
        } catch (error) {
          console.error("خطا در دریافت کارمزد");
          setFeeAmount(0);
        } finally {
          setIsFeeLoading(false);
        }
      }, 600);

      return () => {
        setIsFeeLoading(false);
        clearTimeout(debounceTimer);
      };
    }
  }, [calculatedBasePayable, selectedGateway, currentProvider]); // وابسته به مبلغ خالص

  // --- 4. Logic: Final Totals (Tax & Payale) ---

  // محاسبه مالیات بر اساس مبلغ خالص (نه مبلغ کل اولیه)
  const TAX_RATE = currentProvider ? currentProvider.taxRate : 0;
  const taxAmount = Math.floor((calculatedBasePayable * TAX_RATE) / 100);

  // مبلغ نهایی قابل پرداخت (پایه + مالیات + کارمزد)
  let finalPayableAmount = calculatedBasePayable + taxAmount + feeAmount;

  // اگر پایه صفر شده (تخفیف ۱۰۰ درصدی)، کل مبلغ صفر می‌شود (مگر اینکه لاجیک خاصی برای کارمزد ثابت داشته باشید)
  if (calculatedBasePayable === 0) {
    finalPayableAmount = 0;
  }

  // مبلغی که به موجودی کاربر اضافه می‌شود (مبلغ درخواستی + هدیه تعدیل اگر وجود داشته باشد)
  // adjustmentGap پولی است که کاربر مجبور شده اضافه پرداخت کند تا به کف درگاه برسد، پس به شارژش اضافه می‌کنیم.
  const userChargeAmount = numAmount + adjustmentGap;
  const projectedBalance = CURRENT_BALANCE + userChargeAmount;



  // --- Handlers ---

  const handleApplyCoupon = async (codes: string[]) => {
    setIsCouponLoading(true);
    try {
      const res = await req.post<SendResType<MultipleCouponResult>>(
        "deposit/payment/coupon/validate",
        {
          amount: numAmount, // برای بررسی کوپن معمولا مبلغ اولیه (بدون تعدیل) ارسال می‌شود
          couponsCode: codes,
        }
      );

      const result = res.data;
      if (result.status === "ok") {
        return result.data;
      }
      throw new Error(result.msg);
    } catch (e) {
      handleAxiosError(e);
      return null;
    } finally {
      setIsCouponLoading(false);
    }
  };

  const handleAddCoupon = (coupon: IAppliedCoupon) => {
    setAppliedCoupons((prev) => [...prev, coupon]);
  };

  const handleRemoveCoupon = (code: string) => {
    setAppliedCoupons((prev) => prev.filter((c) => c.code !== code));
  };

  // بررسی مجدد کوپن‌ها در صورت تغییر مبلغ یا درگاه
  useEffect(() => {
    if (appliedCoupons.length) {
      async function fetchData() {
        try {
          const result = await handleApplyCoupon(
            appliedCoupons.map((e) => e.code)
          );
          if (!result) throw "خطا در خواندن کد تخفیف";
          if (result.isValid && result.totalDiscount) {
            setAppliedCoupons(
              result.appliedCoupons.map((e) => ({
                ...e,
                description: e.description || "تخفیف ویژه",
              }))
            );
          }
        } catch (e) {
          // هندل خطا
        }
      }
      const debounceTimer = setTimeout(() => {
        fetchData();
      }, 600);
      return () => clearTimeout(debounceTimer);
    }
  }, [amount, selectedGateway]);

  const onPay = async () => {
    setPaymentURLLoading(true);

    try {
      const url = `deposit/payment/request`;
      const res = await req.post(url, {
        amount: numAmount, // مبلغی که کاربر قصد شارژ دارد
        gatewayName: selectedGateway,
        couponsCode: appliedCoupons.map((e) => e.code),
      });

      const data = res.data;
      if (data.status === "nok") {
        throw new Error(data.msg || "خطا در ایجاد درخواست پرداخت");
      }

      if (data.data && data.data.url) {
        window.location.href = data.data.url;
      } else {
        throw new Error("لینک پرداخت دریافت نشد.");
      }
    } catch (e: any) {
      if (axios.isCancel(e) || e.name === "CanceledError") return;
      handleAxiosError(e, "خطا در ساخت لینک درگاه پرداخت");
    } finally {
      setPaymentURLLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col pb-60 md:pb-10 overflow-x-hidden selection:bg-[var(--accent-primary)] selection:text-white">
      {/* Mobile Header (Scroll Aware) */}
      <header
        className={`fixed top-0 left-0 right-0 z-30 transition-all duration-500 md:hidden px-4 py-3 ${
          scrolled
            ? "glass-panel border-b border-[var(--card-border)] bg-white/95 shadow-lg"
            : "-translate-y-full opacity-0"
        }`}
      >
        <div className="flex justify-between items-center max-w-3xl mx-auto">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-[var(--gold-bg)] text-[var(--gold-primary)] rounded-xl">
              <WalletIcon size={18} />
            </div>
            <div className="flex flex-col">
              <span className="text-[8px] font-black text-[var(--text-secondary)]">
                موجودی فعلی
              </span>
              <span className="text-sm font-black dir-ltr">
                {formatCurrency(toToman(CURRENT_BALANCE))} T
              </span>
            </div>
          </div>
          <div className="bg-[var(--leaf-bg)] px-3 py-1.5 rounded-full flex items-center gap-1.5">
            <ShieldCheck size={14} className="text-[var(--accent-primary)]" />
            <span className="text-[10px] font-black">درگاه امن</span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto w-full sm:p-6 md:p-8 lg:p-6 xl:p-12 flex flex-col md:flex-row gap-10 xl:gap-16 lg:gap-6 items-start flex-grow pt-3 md:pt-12 xl:pt-24">
        {/* Primary Interaction Column */}
        <div className="w-full md:w-7/12 space-y-10 md:space-y-10">
          {/* Header Section */}
          <div>
            <div className="flex items-center gap-4 mb-8">
              <div className="p-3 bg-[var(--gold-bg)] text-[var(--gold-primary)] rounded-[1.25rem] shadow-sm md:shadow-md transition-transform hover:scale-110">
                <Sparkles size={28} />
              </div>
              <div className="flex flex-col">
                <h1 className="text-2xl sm:text-3xl xl:text-5xl font-black text-[var(--text-primary)] leading-tight tracking-tight">
                  شارژ آنی کیف پول
                </h1>
                <p className="text-[var(--text-primary)] mt-1 sm:mt-2 text-sm sm:text-lg font-bold opacity-70">
                  مبلغ شارژ را انتخاب کرده و موجودی خود را ارتقا دهید.
                </p>
              </div>
            </div>
            {/* Mobile Preview Positioning */}
            <div className="md:hidden max-w-2xl mx-auto mb-10">
              <WalletPreview
                currentBalance={CURRENT_BALANCE}
                newBalance={projectedBalance}
              />
            </div>
          </div>

          <div className="space-y-6">
            <AmountInput
              amount={amount}
              onAmountChange={setAmount}
              disabled={noPaymentPorviders}
              min={toToman(MIN_AMOUNT_GATEWAY)}
              max={toToman(MAX_AMOUNT_GATEWAY)}
            />

            <CouponInput
              appliedCoupons={appliedCoupons}
              onAddCoupon={handleAddCoupon}
              onRemoveCoupon={handleRemoveCoupon}
              validateCoupon={handleApplyCoupon}
              disabled={!numAmount || noPaymentPorviders}
            />

            <GatewaySelector
              selectedGateway={selectedGateway}
              onSelect={setSelectedGateway}
              gateways={paymentSettings}
            />
          </div>
        </div>

        {/* Right Column: Sticky Sidebar */}
        <div className="w-full md:w-5/12 space-y-6 md:sticky md:top-24 h-fit">
          <div className="hidden md:block">
            <WalletPreview
              currentBalance={CURRENT_BALANCE}
              newBalance={projectedBalance}
            />
          </div>
          <div className="hidden md:block">
            <PaymentSummary
              taxRate={TAX_RATE}
              amount={userChargeAmount} // مبلغ شارژ کیف پول (شامل تعدیل)
              taxAmount={taxAmount}
              feeAmount={feeAmount}
              appliedCoupons={appliedCoupons}
              finalAmount={finalPayableAmount} // مبلغ کسر شده از حساب بانکی
              isValid={isValid}
              onPay={onPay}
              isRedirecting={paymentURLLoading}
              isLoading={loading || isFeeLoading}
              disabled={noPaymentPorviders || isFeeLoading}
              isAdjusted={isAdjusted}
              adjustmentGap={adjustmentGap}
            />
          </div>
        </div>
      </main>

      {/* Mobile Sticky Summary Footer */}
      <div className="fixed bottom-0 left-0 right-0 z-40 md:hidden">
        <div className="glass-panel border-t border-[var(--card-border)] bg-white/95 backdrop-blur-3xl px-6 pt-4 pb-10 shadow-[0_-10px_30px_rgba(0,0,0,0.1)]">
          <PaymentSummary
            taxRate={TAX_RATE}
            isMobileFooter
            amount={userChargeAmount}
            taxAmount={taxAmount}
            feeAmount={feeAmount}
            appliedCoupons={appliedCoupons}
            finalAmount={finalPayableAmount}
            isValid={isValid}
            onPay={onPay}
            isLoading={loading || isFeeLoading}
            disabled={noPaymentPorviders || isFeeLoading}
            isAdjusted={isAdjusted}
            adjustmentGap={adjustmentGap}
          />
        </div>
      </div>
    </div>
  );
}
