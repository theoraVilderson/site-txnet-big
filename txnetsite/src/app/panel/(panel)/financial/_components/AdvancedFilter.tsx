// components/AdvancedFilter.tsx
"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Filter, X, Search, CheckCircle2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {} from "@/types/transaction";
import { useLoading } from "../_context/LoadingContext"; // استفاده از کانتکست لودینگ که قبلا ساختیم
import { PersianDatePicker } from "./PersianDatePicker"; // <--- ایمپورت جدید
import { TransactionStatus, TransactionType } from "@/configs/transactions";
import { toEnglishDigits } from "@util/helper";
export function AdvancedFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const { startLoading } = useLoading();

  // States
  const [filters, setFilters] = useState({
    search: searchParams.get("search") || "",
    type: searchParams.get("type") || "ALL",
    status: searchParams.get("status") || "ALL",
    startDate: searchParams.get("startDate") || "", // <--- فیلد جدید
    endDate: searchParams.get("endDate") || "", // <--- فیلد جدید
  });

  const handleApply = () => {
    startLoading(); // نمایش لودینگ

    const params = new URLSearchParams();
    if (filters.search) params.set("search", filters.search);
    if (filters.type !== "ALL") params.set("type", filters.type);
    if (filters.status !== "ALL") params.set("status", filters.status);

    // ارسال تاریخ‌ها به URL
    if (filters.startDate)
      params.set("startDate", toEnglishDigits(filters.startDate));
    if (filters.endDate)
      params.set("endDate", toEnglishDigits(filters.endDate));

    params.set("page", "1");

    router.push(`?${params.toString()}`);
    setIsOpen(false);
  };

  const handleReset = () => {
    startLoading();
    setFilters({
      search: "",
      type: "ALL",
      status: "ALL",
      startDate: "",
      endDate: "",
    });
    router.push("?");
    setIsOpen(false);
  };

  return (
    <div className="mb-6 z-20 relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-5 py-2.5 rounded-xl transition-all duration-300 font-medium ${
          isOpen
            ? "bg-[var(--accent-primary)] text-white shadow-lg shadow-[var(--accent-glow)]"
            : "glass-panel text-[var(--text-primary)] hover:bg-[var(--leaf-bg)]"
        }`}
      >
        <Filter size={18} />
        <span>فیلتر پیشرفته</span>
        {/* نمایش نقطه قرمز اگر فیلتری فعال باشد */}
        {(filters.type !== "ALL" || filters.startDate) && !isOpen && (
          <span className="w-2 h-2 rounded-full bg-[var(--error-color)] absolute top-2 right-2 animate-pulse"></span>
        )}
        {isOpen ? <X size={16} /> : null}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0, y: -10 }}
            animate={{ height: "auto", opacity: 1, y: 0 }}
            exit={{ height: 0, opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="mt-3 glass-panel p-6 rounded-2xl border border-[var(--card-border)] shadow-xl">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {/* جستجو */}
                <div className="col-span-1 md:col-span-4">
                  <label className="text-xs text-[var(--text-secondary)] mb-1 block">
                    جستجو
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={filters.search}
                      onChange={(e) =>
                        setFilters({ ...filters, search: e.target.value })
                      }
                      className="w-full pl-4 pr-10 py-3 rounded-xl bg-[var(--bg-inner)] border border-[var(--card-border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                      placeholder="عنوان تراکنش..."
                    />
                    <Search
                      className="absolute right-3 top-3.5 text-[var(--text-secondary)]"
                      size={18}
                    />
                  </div>
                </div>

                {/* دراپ‌داون‌ها (کد قبلی) ... */}
                <div>
                  <label className="text-xs text-[var(--text-secondary)] mb-1 block">
                    نوع
                  </label>
                  <select
                    value={filters.type}
                    onChange={(e) =>
                      setFilters({ ...filters, type: e.target.value })
                    }
                    className="w-full px-3 py-3 rounded-xl bg-[var(--bg-inner)] border border-[var(--card-border)] text-[var(--text-primary)] focus:outline-none"
                  >
                    <option value="ALL">همه</option>
                    <option value={TransactionType.DEPOSIT}>واریز</option>
                    <option value={TransactionType.PURCHASE}>خرید</option>
                    <option value={TransactionType.USAGE_DAILY}>مصرف</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-[var(--text-secondary)] mb-1 block">
                    وضعیت
                  </label>
                  <select
                    value={filters.status}
                    onChange={(e) =>
                      setFilters({ ...filters, status: e.target.value })
                    }
                    className="w-full px-3 py-3 rounded-xl bg-[var(--bg-inner)] border border-[var(--card-border)] text-[var(--text-primary)] focus:outline-none"
                  >
                    <option value="ALL">همه</option>
                    <option value={TransactionStatus.SUCCESS}>موفق</option>
                    <option value={TransactionStatus.PENDING}>انتظار</option>
                    <option value={TransactionStatus.FAILED}>ناموفق</option>
                  </select>
                </div>

                {/* --- بخش جدید تاریخ --- */}
                <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <PersianDatePicker
                    label="از تاریخ"
                    placeholder="۱۴۰۲/۰۱/۰۱"
                    value={filters.startDate}
                    onChange={(date) =>
                      setFilters({ ...filters, startDate: date })
                    }
                  />
                  <PersianDatePicker
                    label="تا تاریخ"
                    placeholder="۱۴۰۲/۱۲/۲۹"
                    value={filters.endDate}
                    onChange={(date) =>
                      setFilters({ ...filters, endDate: date })
                    }
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-[var(--card-border)]">
                <button
                  onClick={handleReset}
                  className="px-6 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--leaf-bg)] transition-colors"
                >
                  بازنشانی
                </button>
                <button
                  onClick={handleApply}
                  className="px-6 py-2 rounded-lg bg-[var(--accent-primary)] text-white text-sm font-medium shadow-lg hover:scale-105 transition-transform flex items-center gap-2"
                >
                  <CheckCircle2 size={16} /> اعمال فیلترها
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
