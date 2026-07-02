"use client";
import React from "react";
import { Wallet, Zap } from "lucide-react";
import { formatCurrency } from "../../_util/format";
import { useAuthStore } from "@app/panel/(panel)/_stores/useAuthStore";
import { toToman } from "@util/helper";

interface WalletPreviewProps {
  newBalance: number;
  currentBalance: number;
}
const WalletPreview: React.FC<WalletPreviewProps> = ({
  newBalance,
  currentBalance,
}) => {
  return (
    <div className="relative group perspective-1000 w-full select-none">
      {/* Dynamic Background Glow */}
      <div className="absolute inset-0 bg-[var(--accent-primary)] blur-[40px] md:blur-[60px] opacity-15 group-hover:opacity-25 transition-opacity duration-700 rounded-[2.5rem]"></div>

      <div
        className="relative w-full aspect-[1.586/1] rounded-[2rem] md:rounded-[2.25rem] p-5 sm:p-8 md:p-5 lg:h-[250px]  xl:h-auto lg:p-7 flex flex-col justify-between text-white shadow-2xl overflow-hidden transition-all duration-500 md:hover:scale-[1.01] active:scale-[0.98]"
        style={{
          background: "var(--card-gradient)",
          boxShadow: "0 20px 50px -12px var(--card-shadow)",
        }}
      >
        {/* Aesthetic Decorative Patterns */}
        <div className="absolute inset-0 opacity-[0.03] bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] pointer-events-none"></div>
        <div className="absolute -right-10 -top-10 w-48 h-48 bg-white opacity-10 rounded-full blur-[80px] pointer-events-none"></div>

        {/* Card Header Section */}
        <div className="flex justify-between items-start z-10">
          <div className="flex flex-col gap-0.5 sm:gap-1">
            <span className="text-white/60 text-[9px] sm:text-sm md:text-[9px] lg:text-xs font-black uppercase tracking-widest opacity-80">
              موجودی فعلی
            </span>
            <div className="flex items-baseline gap-1.5 sm:gap-2">
              <span className="text-lg sm:text-4xl md:text-xl lg:text-2xl font-black dir-ltr tracking-tight leading-none">
                {formatCurrency(toToman(currentBalance))}
              </span>
              <span className="text-[9px] sm:text-base md:text-[10px] lg:text-xs opacity-60 font-black">
                تومان
              </span>
            </div>
          </div>
          <div className="p-2.5 sm:p-5 md:p-2.5 lg:p-3 bg-white/10 backdrop-blur-md rounded-xl sm:rounded-2xl border border-white/10 shadow-sm">
            <Wallet className="text-white/90 w-4 h-4 sm:w-8 sm:h-8 md:w-4 md:h-4 lg:w-5 lg:h-5" />
          </div>
        </div>

        {/* Card Security Chip & Interactive Element */}
        <div className="flex items-center gap-2.5 sm:gap-4 z-10 my-1 sm:my-4 md:my-1 lg:my-2">
          <div className="w-9 h-6 sm:w-16 sm:h-10 md:w-10 md:h-6 lg:w-12 lg:h-8 rounded-md bg-gradient-to-br from-yellow-100 via-yellow-400 to-yellow-600 shadow-lg flex items-center justify-center relative overflow-hidden ring-1 ring-white/10">
            <div className="w-full h-full border border-black/5 rounded flex items-center justify-center gap-1 sm:gap-2 md:gap-1">
              <div className="w-px h-5 sm:h-8 md:h-5 bg-black/10"></div>
              <div className="w-px h-5 sm:h-8 md:h-5 bg-black/10"></div>
              <div className="w-px h-5 sm:h-8 md:h-5 bg-black/10"></div>
            </div>
          </div>
          <Zap
            size={18}
            className="text-yellow-300 animate-pulse drop-shadow-[0_0_8px_rgba(253,224,71,0.6)] sm:scale-150 md:scale-100 lg:scale-110"
          />
        </div>

        {/* Card Footer: Live Projected Balance */}
        <div className="z-10 space-y-0.5 sm:space-y-2 md:space-y-0.5 lg:space-y-1 mt-auto pt-2 sm:pt-5 md:pt-2 lg:pt-3 border-t border-white/10">
          <span className="text-white/50 text-[9px] sm:text-sm md:text-[9px] lg:text-xs font-black uppercase tracking-wide">
            برآورد موجودی پس از شارژ
          </span>
          <div className="flex justify-between items-end gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xl sm:text-5xl md:text-2xl lg:text-3xl font-black text-white dir-ltr drop-shadow-2xl truncate leading-tight">
                {formatCurrency(toToman(newBalance))}
              </p>
            </div>
            <div className="flex flex-col items-end shrink-0 pb-1 sm:pb-2.5 md:pb-1">
              <span className="text-white/80 text-[9px] sm:text-base md:text-[10px] lg:text-xs font-black tracking-tighter">
                IRT
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WalletPreview;
