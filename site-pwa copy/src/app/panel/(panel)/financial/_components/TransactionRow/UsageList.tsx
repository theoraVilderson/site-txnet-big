import React from "react";
import { Server, Globe, Wifi, HardDrive, Clock } from "lucide-react";
import { cn, formatCurrency, formatPersianTime } from "../../_util/format";
import { toToman } from "@util/helper";

interface UsageDetail {
  reason: string;
  discountAmount?: number;
  couponCode?: string;
  serviceId: string;
  timestamp: string;
  cost: number;
}

interface UsageListProps {
  details: UsageDetail[];
}

export const UsageList: React.FC<UsageListProps> = ({ details }) => {
  if (!details || details.length === 0) return null;

  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-xl overflow-hidden">
      <div className="bg-[var(--leaf-bg)]/50 px-4 py-2 border-b border-[var(--card-border)] flex justify-between items-center">
        <span className="text-xs font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Server size={14} className="text-[var(--accent-primary)]" />
          جزئیات مصرف
        </span>
      </div>
      <div className="divide-y divide-[var(--card-border)]">
        {details.map((detail, idx) => {
          const detailDiscount = detail.discountAmount || 0;
          const originalCost = detail.cost + detailDiscount;

          return (
            <div
              key={idx}
              className="grid grid-cols-12 gap-2 px-4 py-3 hover:bg-[var(--leaf-bg)]/10 transition-colors"
            >
              {/* بخش آیکون و نام سرویس */}
              <div className="col-span-12 md:col-span-6 flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[var(--bg-inner)] border border-[var(--card-border)] flex items-center justify-center text-[var(--text-secondary)] shadow-sm">
                  {detail.reason.includes("ترافیک") ? (
                    <Globe size={16} />
                  ) : detail.reason.includes("IP") ? (
                    <Wifi size={16} />
                  ) : (
                    <HardDrive size={16} />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-xs md:text-sm font-medium text-[var(--text-primary)]">
                      {detail.reason}
                    </p>
                    {detailDiscount > 0 && (
                      <span className="text-[9px] bg-rose-500/10 text-rose-500 px-1.5 rounded border border-rose-500/20 whitespace-nowrap">
                        {detail.couponCode}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
                    SvcID: {detail.serviceId}
                  </p>
                </div>
              </div>

              {/* زمان */}
              <div className="col-span-6 md:col-span-3 flex items-center gap-1.5 md:justify-center text-[var(--text-secondary)]">
                <Clock size={12} />
                <span
                  suppressHydrationWarning
                  className="text-[11px] font-mono dir-ltr"
                >
                  {formatPersianTime(detail.timestamp)}
                </span>
              </div>

              {/* هزینه */}
              <div className="col-span-6 md:col-span-3 flex flex-col items-end justify-center">
                {detailDiscount > 0 ? (
                  <>
                    <span className="text-[10px] text-rose-400 line-through decoration-rose-400/50 dir-ltr opacity-80">
                      {formatCurrency(toToman(originalCost))}
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-bold text-emerald-600 dir-ltr">
                        {formatCurrency(toToman(detail.cost))}
                      </span>
                      <span className="text-[9px] text-[var(--text-secondary)]">
                        تومان
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-xs font-bold text-[var(--text-primary)] dir-ltr">
                      {formatCurrency(toToman(detail.cost))}
                    </span>
                    <span className="text-[9px] text-[var(--text-secondary)]">
                      تومان
                    </span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
