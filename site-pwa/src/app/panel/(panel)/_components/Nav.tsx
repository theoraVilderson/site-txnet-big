import React from "react";
import { HiddenOnPhone } from "./HiddenOnPhone";
import { ThemeToggle } from "@/components/ThemeToggle";
import VaultDropdown from "./Vault";
import Vault from "./Vault";
import Notifications, { Notification } from "./Notifications";
import ProfileDropdown from "./ProfileDropdown";
import { Menu } from "lucide-react";
import { useDashboardUIStore } from "../_stores/useDashboardUiStore";

// --- Dummy Data (Simulated Server Response) ---
const DUMMY_NOTIFICATIONS: Notification[] = [
  {
    id: 1,
    title: "واریز موفق",
    desc: "مبلغ ۵۰۰,۰۰۰ تومان به کیف پول افزوده شد.",
    time: "۲ دقیقه پیش",
    isRead: false,
    type: "success",
  },
  {
    id: 2,
    title: "هشدار امنیتی",
    desc: "تلاش ناموفق برای ورود به حساب شما ثبت شد.",
    time: "۱ ساعت پیش",
    isRead: false,
    type: "warning",
  },
  {
    id: 3,
    title: "بروزرسانی سیستم",
    desc: "نسخه جدید پنل با موفقیت نصب شد.",
    time: "دیروز",
    isRead: true,
    type: "info",
  },
];

type Props = {};

export default function Nav({}: Props) {
  const setIsMobileMenuOpen = useDashboardUIStore((s) => s.setIsMobileMenuOpen);
  return (
    <header className="h-20 flex items-center justify-between px-4 sm:px-6 lg:px-8 mt-4 mx-4 rounded-2xl glass-panel z-30 shrink-0">
      {/* Left: Mobile Toggle (Spacer on Desktop) */}
      <div className="flex items-center">
        <button
          onClick={() => setIsMobileMenuOpen(true)}
          className="lg:hidden p-2 rounded-lg cursor-pointer bg-[var(--leaf-bg)] text-[var(--text-primary)]"
        >
          <Menu size={24} />
        </button>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center  sm:gap-4 lg:gap-5">
        {/* Theme Toggle */}
        <HiddenOnPhone>
          <ThemeToggle />
        </HiddenOnPhone>

        {/* Wallet (Vault) - Visible on Mobile now */}
        <Vault />
        {/* Notification */}
        <Notifications notifs={DUMMY_NOTIFICATIONS} />

        {/* Profile Dropdown */}
        <ProfileDropdown />
      </div>
    </header>
  );
}
