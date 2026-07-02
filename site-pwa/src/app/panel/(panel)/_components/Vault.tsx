"use client";
import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import {
  Wallet,
  ChevronDown,
  PlusCircle,
  ArrowUpRight,
  History,
  CreditCard,
  Ticket,
} from "lucide-react";
import { useDashboardUIStore } from "../_stores/useDashboardUiStore";
import DiscountModal from "./DiscountModal";
import { useAuthStore } from "../_stores/useAuthStore";
import { toToman } from "@util/helper";

export default function Vault() {
  const isValutOpen = useDashboardUIStore((s) => s.isValutOpen);
  const setIsValutOpen = useDashboardUIStore((s) => s.setIsValutOpen);
  const isGiftCodeModalOpen = useDashboardUIStore((s) => s.isGiftCodeModalOpen);
  const setIsGiftCodeModalOpen = useDashboardUIStore(
    (s) => s.setIsGiftCodeModalOpen
  );
  const userValutBalance = useAuthStore((s) => s.user!.walletBalance);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // بستن منو با کلیک در فضای بیرونی
  useEffect(() => {
    function handleClickOutside(event: PointerEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsValutOpen(false);
      }
    }
    document.addEventListener("pointerdown", handleClickOutside);
    return () =>
      document.removeEventListener("pointerdown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* --- Trigger Button --- */}
      <button
        onClick={() => setIsValutOpen(!isValutOpen)}
        className={`
            cursor-pointer
          flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-1.5 rounded-xl 
          border border-[var(--card-border)]
          transition-all duration-300 ease-out group
          ${
            isValutOpen
              ? "bg-[var(--accent-primary)] border-[var(--accent-primary)] text-white shadow-lg shadow-[var(--accent-glow)]"
              : "bg-[var(--leaf-bg)] text-[var(--text-primary)] hover:border-[var(--accent-primary)]"
          }
        `}
      >
        {/* Wallet Icon Box */}
        <div
          className={`
          w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center transition-all duration-500
          ${
            isValutOpen
              ? "bg-white/20 text-white rotate-[360deg]"
              : "bg-[var(--accent-primary)] text-white group-hover:scale-110"
          }
        `}
        >
          <Wallet size={14} className="sm:hidden" />
          <Wallet size={16} className="hidden sm:block" />
        </div>

        {/* Text & Balance */}

        <div className="flex flex-col text-right leading-tight">
          <span
            className={`text-[10px] font-bold transition-colors ${
              isValutOpen ? "text-white/80" : "text-[var(--text-secondary)]"
            }`}
          >
            موجودی تکسنت‌ولت
          </span>
          <span className="text-sm font-bold font-mono flex items-center gap-1">
            <span
              className={
                isValutOpen ? "text-white" : "text-[var(--gold-primary)]"
              }
            >
              {toToman(userValutBalance).toLocaleString()}
            </span>
            <span
              className={`text-[10px] ${
                isValutOpen ? "text-white/80" : "text-[var(--text-secondary)]"
              }`}
            >
              تومان
            </span>
          </span>
        </div>

        {/* Chevron Icon */}
        <ChevronDown
          size={14}
          className={`
            ml-1 transition-transform duration-500 cubic-bezier(0.4, 0, 0.2, 1)
            ${
              isValutOpen
                ? "rotate-180 text-white"
                : "text-[var(--text-secondary)] group-hover:text-[var(--accent-primary)]"
            }
          `}
        />
      </button>

      {/* --- Dropdown Menu --- */}
      <div
        className={`
          absolute right-0 sm:right-auto sm:left-0 mt-3 w-72 p-3 
          glass-panel rounded-2xl shadow-xl shadow-[var(--accent-glow)]/20
          origin-top-left border border-[var(--card-border)]
          transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]
          ${
            isValutOpen
              ? "transform scale-100 opacity-100 translate-y-0 visible"
              : "transform scale-90 opacity-0 -translate-y-2 invisible pointer-events-none"
          }
        `}
      >
        {/* Header / Summary */}
        <div className="flex justify-between items-center mb-3 px-1">
          <span className="text-xs font-bold text-[var(--text-secondary)]">
            عملیات سریع
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--leaf-bg)] text-[var(--accent-primary)]">
            فعال
          </span>
        </div>

        {/* Action Grid */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          {/* Deposit Button (Highlighted) */}
          <Link
            href="/financial/deposit"
            className="col-span-2 flex items-center justify-center gap-2 p-3 rounded-xl bg-[var(--accent-primary)] text-white hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-[var(--accent-glow)]"
          >
            <PlusCircle size={18} />
            <span className="font-bold text-sm">افزایش موجودی</span>
          </Link>

          {/* Withdraw Button */}
          <button
            onClick={() => {
              setIsValutOpen(false);
              setIsGiftCodeModalOpen(true);
            }}
            className="w-full flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl bg-[var(--leaf-bg)] text-[var(--text-primary)] hover:bg-[var(--card-border)] transition-all border border-transparent hover:border-[var(--accent-primary)]/20 active:scale-95"
          >
            <Ticket size={20} className="text-orange-500" />
            <span className="text-xs font-medium">کد هدیه</span>
          </button>

          {/* History Button */}
          <Link
            href="/financial/"
            className="flex flex-col items-center justify-center gap-1 p-3 rounded-xl bg-[var(--leaf-bg)] text-[var(--text-primary)] hover:bg-[var(--card-border)] transition-colors border border-transparent hover:border-[var(--card-border)]"
          >
            <History size={18} className="text-blue-500" />
            <span className="text-xs font-medium">تاریخچه</span>
          </Link>
        </div>

        {/* Divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-[var(--card-border)] to-transparent my-4" />

        {/* Footer Link */}
        <Link
          href={"/services"}
          className="w-full flex items-center justify-between px-3 py-3 rounded-xl text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--leaf-bg)] transition-all group border border-transparent hover:border-[var(--card-border)]"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 rounded-lg group-hover:bg-[var(--accent-primary)] group-hover:text-white transition-colors">
              <CreditCard size={14} />
            </div>
            <span className="font-medium">خرید سرویس‌های تکسنت</span>
          </div>
          <ChevronDown
            size={14}
            className="-rotate-90 opacity-40 group-hover:translate-x-[-4px] transition-transform"
          />
        </Link>
      </div>
      {/* The New Modal */}
      <DiscountModal
        isOpen={isGiftCodeModalOpen}
        onClose={() => setIsGiftCodeModalOpen(false)}
      />
    </div>
  );
}
