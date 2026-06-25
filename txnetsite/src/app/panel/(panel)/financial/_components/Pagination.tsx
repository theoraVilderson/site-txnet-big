// components/Pagination.tsx
"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "../_util/format";
import { useLoading } from "../_context/LoadingContext";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage?: number;
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage = 10,
}: PaginationProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { startLoading } = useLoading();
  // اگر کلاً ۱ صفحه داریم، چیزی نشان نده
  if (totalPages <= 1) return null;

  // --- Logic تغییر صفحه ---
  const handlePageChange = (page: number) => {
    if (page < 1 || page > totalPages || page === currentPage) return;
    startLoading();
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", page.toString());
    router.push(`?${params.toString()}`, { scroll: false }); // scroll: false برای جلوگیری از پرش ناگهانی
  };

  // --- Logic تولید اعداد صفحات (الگوریتم هوشمند) ---
  const generatePagination = () => {
    // اگر تعداد صفحات کم است (کمتر از ۷)، همه را نشان بده
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    // اگر در صفحات ابتدایی هستیم
    if (currentPage <= 3) {
      return [1, 2, 3, 4, "...", totalPages];
    }

    // اگر در صفحات انتهایی هستیم
    if (currentPage >= totalPages - 2) {
      return [
        1,
        "...",
        totalPages - 3,
        totalPages - 2,
        totalPages - 1,
        totalPages,
      ];
    }

    // اگر در وسط هستیم
    return [
      1,
      "...",
      currentPage - 1,
      currentPage,
      currentPage + 1,
      "...",
      totalPages,
    ];
  };

  const pages = generatePagination();

  // محاسبه بازه نمایشی (مثلا: نمایش ۱۱ تا ۲۰)
  const startItem = (currentPage - 1) * itemsPerPage + 1;
  const endItem = Math.min(currentPage * itemsPerPage, totalItems);

  return (
    <div className="flex flex-col md:flex-row items-center justify-between gap-4 py-4 mt-6 border-t border-[var(--card-border)] animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* بخش اطلاعات آماری (چپ چین در دسکتاپ) */}
      <div className="text-sm text-[var(--text-secondary)] order-2 md:order-1">
        نمایش{" "}
        <span className="font-bold text-[var(--text-primary)] mx-1">
          {startItem}
        </span>
        تا{" "}
        <span className="font-bold text-[var(--text-primary)] mx-1">
          {endItem}
        </span>
        از{" "}
        <span className="font-bold text-[var(--text-primary)] mx-1">
          {totalItems}
        </span>{" "}
        تراکنش
      </div>

      {/* بخش دکمه‌ها (راست چین در دسکتاپ) */}
      <div className="flex items-center gap-2 order-1 md:order-2 bg-[var(--card-bg)] p-1 rounded-xl border border-[var(--card-border)] shadow-sm">
        {/* دکمه قبلی */}
        <button
          onClick={() => handlePageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="p-2 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--leaf-bg)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:hover:bg-transparent transition-all active:scale-95"
          title="صفحه قبل"
        >
          <ChevronRight size={18} />
        </button>

        {/* اعداد صفحات (فقط در تبلت و دسکتاپ) */}
        <div className="hidden sm:flex items-center gap-1">
          {pages.map((page, index) => {
            if (page === "...") {
              return (
                <span
                  key={`ellipsis-${index}`}
                  className="px-2 text-[var(--text-secondary)]"
                >
                  <MoreHorizontal size={16} />
                </span>
              );
            }

            const pageNum = page as number;
            const isActive = pageNum === currentPage;

            return (
              <button
                key={pageNum}
                onClick={() => handlePageChange(pageNum)}
                className={cn(
                  "min-w-[36px] h-9 rounded-lg text-sm font-medium transition-all duration-300",
                  isActive
                    ? "bg-[var(--accent-primary)] text-white shadow-md shadow-[var(--accent-glow)] scale-105"
                    : "text-[var(--text-secondary)] hover:bg-[var(--leaf-bg)] hover:text-[var(--text-primary)]"
                )}
              >
                {pageNum}
              </button>
            );
          })}
        </div>

        {/* نمایش ساده در موبایل (به جای اعداد) */}
        <span className="sm:hidden text-sm font-medium text-[var(--text-primary)] px-2">
          {currentPage} / {totalPages}
        </span>

        {/* دکمه بعدی */}
        <button
          onClick={() => handlePageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="p-2 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--leaf-bg)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:hover:bg-transparent transition-all active:scale-95"
          title="صفحه بعد"
        >
          <ChevronLeft size={18} />
        </button>
      </div>
    </div>
  );
}
