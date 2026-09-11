import React, { useState } from "react";
import { Copy, CheckCircle2, LucideIcon } from "lucide-react";
import { cn } from "../../_util/format";
import { copyText } from "@util/front";

interface DetailItemProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  copyable?: boolean;
  className?: string;
  valueClass?: string;
  iconClass?: string;
}

export const DetailItem: React.FC<DetailItemProps> = ({
  icon: Icon,
  label,
  value,
  copyable = false,
  className,
  valueClass,
  iconClass,
}) => {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    if (!copyable) return;
    e.stopPropagation();
    copyText(String(value));
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <div
      onClick={handleCopy}
      className={cn(
        "bg-[var(--card-bg)] border border-[var(--card-border)] p-3 rounded-xl flex flex-col gap-1 transition-all",
        copyable
          ? "cursor-pointer hover:border-[var(--accent-primary)] hover:shadow-sm"
          : "",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 text-[var(--text-secondary)] mb-1",
          iconClass
        )}
      >
        <Icon size={12} />
        <span className="text-[10px]">{label}</span>
      </div>
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-xs font-mono font-medium text-[var(--text-primary)] truncate dir-ltr",
            valueClass
          )}
          title={String(value)}
        >
          {value}
        </span>
        {copyable &&
          (isCopied ? (
            <CheckCircle2 size={12} className="text-emerald-500" />
          ) : (
            <Copy
              size={10}
              className="text-[var(--text-secondary)] opacity-50"
            />
          ))}
      </div>
    </div>
  );
};
