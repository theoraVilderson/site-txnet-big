import {
  CheckCircle2,
  Clock,
  AlertCircle,
  MoreHorizontal,
  CreditCard,
  Wallet,
  Server,
  UserCog,
} from "lucide-react";
import { TransactionStatus, TransactionMethod } from "@/configs/transactions";

// تنظیمات وضعیت
export const getStatusConfig = (status: TransactionStatus) => {
  const configs = {
    [TransactionStatus.SUCCESS]: {
      icon: CheckCircle2,
      label: "موفق",
      className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
    },
    [TransactionStatus.PENDING]: {
      icon: Clock,
      label: "در انتظار",
      className: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    },
    [TransactionStatus.FAILED]: {
      icon: AlertCircle,
      label: "ناموفق",
      className:
        "bg-[var(--error-bg)] text-[var(--error-color)] border-[var(--error-border)]",
    },
  };

  return (
    configs[status] || {
      icon: MoreHorizontal,
      label: "نامشخص",
      className: "bg-gray-100 text-gray-500 border-gray-200",
    }
  );
};

// تنظیمات روش پرداخت
export const getMethodConfig = (method: TransactionMethod) => {
  const configs = {
    [TransactionMethod.GATEWAY]: {
      icon: CreditCard,
      label: "درگاه",
      className:
        "bg-[var(--gold-bg)] text-[var(--gold-primary)] border-[var(--gold-primary)]/20",
    },
    [TransactionMethod.WALLET]: {
      icon: Wallet,
      label: "کیف‌‌پول",
      className:
        "bg-[var(--leaf-bg)] text-[var(--accent-primary)] border-[var(--accent-primary)]/20",
    },
    [TransactionMethod.SYSTEM]: {
      icon: Server,
      label: "سیستم",
      className:
        "bg-[var(--bg-inner)] text-[var(--text-secondary)] border-[var(--card-border)]",
    },
    [TransactionMethod.ADMIN]: {
      icon: UserCog,

      label: "ادمین",

      className:
        "bg-[var(--bg-inner)] text-[var(--text-secondary)] border-[var(--card-border)]",
    },
  };

  return configs[method];
};
