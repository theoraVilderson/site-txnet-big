"use client";

import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  Copy,
  Hash,
  Landmark,
  Receipt,
  Tag,
  Percent,
  CheckCircle2,
  CreditCard,
  Wallet,
} from "lucide-react";
import { ITransactionWithBalance } from "@/types/transaction";
import { formatCurrency, formatPersianDate, cn } from "../_util/format";
import { TransactionDirection } from "@/configs/transactions";
import { toToman } from "@util/helper";
import { copyText } from "@util/front";

// Sub-components
import { getStatusConfig, getMethodConfig } from "./TransactionRow/utils";
import { TransactionIcon } from "./TransactionRow/TransactionIcon";
import { DetailItem } from "./TransactionRow/DetailItem";
import { UsageList } from "./TransactionRow/UsageList";

interface RowProps {
  item: ITransactionWithBalance;
}

export function TransactionRow({ item }: RowProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // --- محاسبات اولیه ---
  const isDeposit = item.direction === TransactionDirection.IN;
  const statusConfig = getStatusConfig(item.status);
  const methodConfig = getMethodConfig(item.method);

  // محاسبه مجموع تخفیف
  const totalDiscount = useMemo(
    () =>
      item.usageDetails?.reduce(
        (acc, detail) => acc + (detail.discountAmount || 0),
        0
      ) ||
      item.discountAmount ||
      0,
    [item.usageDetails, item.discountAmount]
  );

  const hasUsageDetails = (item.usageDetails?.length || 0) > 0;
  const hasDiscount = totalDiscount > 0;

  // شرط باز شدن آکاردئون
  const canExpand = useMemo(
    () =>
      Boolean(
        hasUsageDetails ||
          item.refId ||
          item.authority ||
          item.gatewayName ||
          (item.feeAmount || 0) > 0 ||
          hasDiscount ||
          !!item.couponsCode?.length
      ),
    [hasUsageDetails, item, hasDiscount]
  );

  const toggleExpand = () => canExpand && setIsExpanded(!isExpanded);

  const handleCopyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyText(item._id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const amount = item.amount;

  return (
    <div className="group relative transition-all duration-300 border-b border-[var(--card-border)] last:border-0 hover:bg-[var(--leaf-bg)]/30">
      <div
        className={cn(
          "absolute right-0 top-0 bottom-0 w-1 transition-colors duration-300",
          isExpanded ? "bg-[var(--accent-primary)]" : "bg-transparent"
        )}
      />

      {/* --- ردیف اصلی --- */}
      <div
        onClick={toggleExpand}
        className={cn(
          "grid grid-cols-12 gap-3 p-4 items-center relative select-none",
          canExpand ? "cursor-pointer" : "cursor-default"
        )}
      >
        {/* ۱. آیکون */}
        <div className="col-span-2 md:col-span-1 flex justify-center">
          <TransactionIcon isDeposit={isDeposit} isExpanded={isExpanded} />
        </div>

        {/* ۲. اطلاعات اصلی */}
        <div className="col-span-7 md:col-span-4 flex flex-col gap-1 pr-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-bold text-[var(--text-primary)] truncate">
              {item.title}
            </p>
            {hasDiscount && (
              <span className="flex items-center gap-0.5 text-[9px] bg-rose-500/10 text-rose-500 px-1.5 py-0.5 rounded-full border border-rose-500/20">
                <Percent size={8} /> تخفیف
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)] font-mono opacity-80">
            <span>ID: {item._id.substring(0, 8)}...</span>
            <button
              onClick={handleCopyId}
              className="hover:text-[var(--accent-primary)] transition-colors p-1 rounded-md hover:bg-[var(--leaf-bg)]"
            >
              {copiedId ? <CheckCircle2 size={10} /> : <Copy size={10} />}
            </button>
          </div>
        </div>

        {/* ۳. مبلغ (بخش اصلاح شده) */}
        <div className="col-span-3 md:col-span-2 flex flex-col items-end md:items-start pl-1 md:pl-0">
          {hasDiscount && (
            <span className="text-[9px] text-[var(--text-secondary)]">
              {isDeposit ? (
                /* حالت واریز: نمایش مبلغ پرداختی واقعی */
                /* مثلا: 100 تومن شارژ - 100 تومن تخفیف = 0 پرداختی */
                <>
                  پرداختی:{" "}
                  <span className="font-mono font-medium">
                    {formatCurrency(
                      toToman(Math.max(0, amount - totalDiscount))
                    )}
                  </span>
                </>
              ) : (
                /* حالت برداشت: نمایش قیمت اصلی خط خورده */
                /* مثلا: 90 تومن کسر شده + 10 تومن تخفیف = 100 تومن قیمت اصلی */
                <span className="line-through decoration-rose-500/50">
                  {formatCurrency(toToman(amount + totalDiscount))}
                </span>
              )}
            </span>
          )}

          {/* مبلغ اصلی تراکنش (تغییر موجودی) */}
          <span
            className={cn(
              "text-sm font-bold dir-ltr tracking-tight",
              isDeposit
                ? "text-[var(--accent-primary)]"
                : "text-[var(--error-color)]"
            )}
          >
            {isDeposit ? "+" : "-"} {formatCurrency(toToman(amount))}
          </span>
          <span className="text-[9px] text-[var(--text-secondary)]">تومان</span>
        </div>

        {/* ۴. وضعیت و تاریخ (فقط دسکتاپ) */}
        <div className="hidden md:flex col-span-2 flex-col items-center justify-center gap-1.5">
          <span
            suppressHydrationWarning
            className="text-[11px] font-mono text-[var(--text-primary)] dir-ltr opacity-90"
          >
            {formatPersianDate(item.createdAt)}
          </span>
          <div className="flex items-center gap-1.5 w-full justify-center">
            <Badge config={statusConfig} />
            <Badge config={methodConfig} hideLabelOnMobile />
          </div>
        </div>

        {/* ۵. مانده و دکمه (دسکتاپ) */}
        <div className="hidden md:flex col-span-3 items-center justify-between pl-2">
          <div className="flex flex-col items-end w-full ml-4">
            <span className="text-[10px] text-[var(--text-secondary)]">
              مانده پس از تراکنش
            </span>
            <span className="text-xs font-medium text-[var(--gold-primary)] font-mono dir-ltr">
              {formatCurrency(toToman(item.balanceAfter))}
            </span>
          </div>
          {canExpand && (
            <ChevronDown
              size={18}
              className={cn(
                "text-[var(--text-secondary)] transition-transform duration-300",
                isExpanded && "rotate-180 text-[var(--accent-primary)]"
              )}
            />
          )}
        </div>

        {/* --- موبایل: ردیف دوم --- */}
        <div className="col-span-12 md:hidden grid grid-cols-2 items-center mt-2 border-t border-[var(--card-border)]/50 pt-2 border-dashed gap-2">
          <div className="flex items-center gap-1.5 overflow-hidden">
            <Badge config={statusConfig} />
            <Badge config={methodConfig} />
          </div>
          <div className="flex items-center justify-end gap-2 text-[var(--text-secondary)]">
            <div className="flex flex-col items-end shrink-0">
              <span
                suppressHydrationWarning
                className="text-[10px] font-mono dir-ltr leading-none mb-1"
              >
                {formatPersianDate(item.createdAt)}
              </span>
              <div className="flex items-center gap-1">
                <span className="text-[9px] opacity-70">مانده:</span>
                <span className="text-[10px] font-medium text-[var(--gold-primary)] dir-ltr">
                  {formatCurrency(toToman(item.balanceAfter))}
                </span>
              </div>
            </div>
            {canExpand && (
              <div className="bg-[var(--leaf-bg)] p-1 rounded-full">
                <ChevronDown
                  size={14}
                  className={cn(
                    "text-[var(--accent-primary)] transition-transform duration-300",
                    isExpanded && "rotate-180"
                  )}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* --- محتوای بازشو --- */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.04, 0.62, 0.23, 0.98] }}
            className="overflow-hidden bg-[var(--bg-inner)] border-t border-[var(--card-border)]"
          >
            <div className="p-4 md:p-6 grid gap-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {item.refId && (
                  <DetailItem
                    icon={Hash}
                    label="شماره ارجاع"
                    value={item.refId}
                    copyable
                  />
                )}
                {item.authority && (
                  <DetailItem
                    icon={Receipt}
                    label="شناسه پرداخت"
                    value={item.authority}
                    copyable
                  />
                )}
                {item.gatewayName && (
                  <DetailItem
                    icon={Landmark}
                    label="درگاه پرداخت"
                    value={item.gatewayName}
                  />
                )}

                {/* نمایش پرداختی واقعی برای واریز در جزئیات */}
                {isDeposit && hasDiscount && (
                  <DetailItem
                    icon={Wallet}
                    label="پرداختی شما"
                    value={`${formatCurrency(
                      toToman(Math.max(0, amount - totalDiscount))
                    )} تومان`}
                  />
                )}

                {!!item.couponsCode?.length && (
                  <DetailItem
                    icon={Tag}
                    label="کد تخفیف"
                    value={item.couponsCode.map((e) => e.code).join("-")}
                    className="border-rose-500/20 bg-rose-500/5"
                    iconClass="text-rose-500"
                  />
                )}

                {hasDiscount && (
                  <DetailItem
                    icon={Percent}
                    label="سود شما"
                    value={`${formatCurrency(toToman(totalDiscount))} تومان`}
                    className="border-rose-500/20 bg-rose-500/5"
                    valueClass="text-rose-600 font-bold"
                  />
                )}

                {(item.feeAmount || 0) > 0 && (
                  <DetailItem
                    icon={CreditCard}
                    label="کارمزد کسر شده"
                    value={`${formatCurrency(
                      toToman(item.feeAmount || 0)
                    )} تومان`}
                  />
                )}
                {(item.taxAmount || 0) > 0 && (
                  <DetailItem
                    icon={CreditCard}
                    label="مالیات کسر شده"
                    value={`${formatCurrency(
                      toToman(item.taxAmount || 0)
                    )} تومان`}
                  />
                )}
              </div>

              {/* ریز مصرف */}
              <UsageList details={item.usageDetails!} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const Badge = ({
  config,
  hideLabelOnMobile,
}: {
  config: any;
  hideLabelOnMobile?: boolean;
}) => (
  <div
    className={cn(
      "flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full border shadow-sm shrink-0",
      config.className
    )}
  >
    <config.icon size={9} />
    <span
      className={cn(
        "whitespace-nowrap",
        hideLabelOnMobile && "hidden lg:inline"
      )}
    >
      {config.label}
    </span>
  </div>
);
