import React from "react";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { cn } from "../../_util/format";

interface TransactionIconProps {
  isDeposit: boolean;
  isExpanded: boolean;
}

export const TransactionIcon: React.FC<TransactionIconProps> = ({
  isDeposit,
  isExpanded,
}) => {
  return (
    <div
      className={cn(
        "w-10 h-10 md:w-11 md:h-11 rounded-2xl flex items-center justify-center shrink-0 border transition-transform duration-300 shadow-sm",
        isDeposit
          ? "bg-[var(--leaf-bg)] text-[var(--accent-primary)] border-[var(--card-border)]"
          : "bg-[var(--error-bg)] text-[var(--error-color)] border-[var(--error-border)]",
        isExpanded && "scale-105 ring-2 ring-[var(--accent-primary)]/20"
      )}
    >
      {isDeposit ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}
    </div>
  );
};
