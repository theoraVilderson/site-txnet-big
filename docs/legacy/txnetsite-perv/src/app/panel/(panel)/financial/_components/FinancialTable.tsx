// components/FinancialTable.tsx
"use client";

import React from "react";
import { ITransactionWithBalance } from "@/types/transaction";
import { TransactionRow } from "./TransactionRow";

interface FinancialTableProps {
  transactions: ITransactionWithBalance[];
}

export function FinancialTable({ transactions }: FinancialTableProps) {
  console.log("page", transactions);
  return (
    <div className="w-full rounded-3xl overflow-hidden border border-[var(--card-border)] bg-[var(--card-bg)] shadow-[0_4px_24px_var(--card-shadow)] backdrop-blur-xl">
      {/* Table Header (Desktop Only) - با گرید TransactionRow هماهنگ شده */}
      <div className="hidden md:grid grid-cols-12 gap-3 px-4 py-4 bg-[var(--leaf-bg)] text-[var(--text-secondary)] text-[11px] font-bold border-b border-[var(--card-border)] select-none">
        <div className="col-span-1 text-center">نوع</div>
        <div className="col-span-4 pr-2">شرح و شناسه</div>
        <div className="col-span-2">مبلغ تراکنش</div>
        <div className="col-span-2 text-center">تاریخ / وضعیت</div>
        <div className="col-span-3 text-left pl-6">مانده حساب</div>
      </div>

      {/* Rows */}
      <div className="min-h-[300px]">
        {transactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-[var(--text-secondary)] opacity-70">
            <div className="w-16 h-16 bg-[var(--leaf-bg)] rounded-full flex items-center justify-center mb-4 text-[var(--accent-primary)]">
              {/* می‌توانید آیکون کیف پول خالی بگذارید */}
              <span className="text-2xl">∅</span>
            </div>
            <p>هیچ تراکنشی یافت نشد.</p>
          </div>
        ) : (
          transactions.map((item) => (
            <TransactionRow key={item._id} item={item} />
          ))
        )}
      </div>
    </div>
  );
}
