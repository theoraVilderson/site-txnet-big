import {
  BookOpen,
  CreditCard,
  Globe,
  Headphones,
  ReceiptText,
  ShoppingCart,
} from "lucide-react"; // توجه: Link اینجا اشتباه ایمپورت شده، باید از next/link باشه یا اگر آیکون هست اسمش رو عوض کن
import NextLink from "next/link"; // ایمپورت صحیح لینک نکست
import React from "react";
import { useDashboardUIStore } from "../_stores/useDashboardUiStore";
import { useShallow } from "zustand/react/shallow";
import {
  X,
  Home,
  Wallet,
  Settings,
  ChevronDown,
  // Link as LinkIcon // اگر آیکون لینک رو میخوای
} from "lucide-react";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle"; // <--- 1. ایمپورت کردن ThemeToggle
import { HiddenOnBiggerPhone } from "./HiddenOnPhone";

// ... (Types and MENU_ITEMS remains the same)
interface MenuItem {
  label: string;
  icon: React.ElementType;
  href?: string;
  submenu?: { label: string; icon: React.ElementType; href: string }[];
}

const MENU_ITEMS: MenuItem[] = [
  { label: "داشبورد", icon: Home, href: "/" },

  { label: "خرید سرویس", icon: ShoppingCart, href: "/buy" },
  { label: "سرویس های من", icon: Globe, href: "/my-services" },
  {
    label: "امور مالی",
    icon: Wallet,
    submenu: [
      { label: "تاریخچه مالی", href: "/financial/", icon: ReceiptText },
      { label: "افزایش موجودی", href: "/financial/deposit", icon: CreditCard },
    ],
  },
  { label: "آموزش و دانلود", icon: BookOpen, href: "/tutorials" },

  // { label: "امنیت", icon: ShieldCheck, href: "/security" },
  { label: "پشتیبانی", icon: Headphones, href: "/support" },

  { label: "تنظیمات", icon: Settings, href: "/settings" },
];

type Props = {};

function Sidebar({}: Props) {
  const pathname = usePathname();

  const { isSidebarOpen, isMobileMenuOpen, openSubmenuIndex } =
    useDashboardUIStore(
      useShallow((s) => ({
        isSidebarOpen: s.isSidebarOpen,
        isMobileMenuOpen: s.isMobileMenuOpen,
        openSubmenuIndex: s.openSubmenuIndex,
      }))
    );

  const {
    setIsMobileMenuOpen,
    setIsSidebarOpen,
    isGiftCodeModalOpen,
    toggleSubmenu,
  } = useDashboardUIStore(
    useShallow((s) => ({
      setIsSidebarOpen: s.setIsSidebarOpen,
      setIsMobileMenuOpen: s.setIsMobileMenuOpen,
      toggleSubmenu: s.toggleSubmenu,
      isGiftCodeModalOpen: s.isGiftCodeModalOpen,
    }))
  );
  const isModalsOpen = [isGiftCodeModalOpen].find((e) => e);
  const shouldSideBarBeTopLayer = isSidebarOpen && !isModalsOpen;
  const zindexSidebar = shouldSideBarBeTopLayer ? "z-32" : "z-30";
  const zindexSidebarBackdrop = shouldSideBarBeTopLayer ? "z-31" : "z-30";
  return (
    <div>
      {/* ================= Sidebar ================= */}
      <aside
        className={`
        fixed inset-y-0 right-0 ${zindexSidebar} flex flex-col
        glass-panel border-l border-[var(--card-border)] border-r-0
        transition-all duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)]
        ${isSidebarOpen ? "w-72" : "w-20"} 
        ${
          isMobileMenuOpen
            ? "translate-x-0"
            : "translate-x-full lg:translate-x-0"
        }
      `}
      >
        {/* Logo Header */}
        <div className="flex h-20 items-center justify-between px-6 border-b border-[var(--card-border)]">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="min-w-[40px] w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--accent-primary)] to-emerald-600 flex items-center justify-center text-white shadow-lg shadow-[var(--accent-glow)]">
              <span className="font-bold text-xl">T</span>
            </div>
            <h1
              className={`text-xl font-bold tracking-tight whitespace-nowrap transition-opacity duration-300 ${
                !isSidebarOpen && "hidden lg:opacity-0 lg:w-0"
              }`}
            >
              پنل تکسنت
            </h1>
          </div>

          {/* دکمه بستن منو + تم تاگل (فقط موبایل) */}
          <div className="flex items-center gap-2 lg:hidden">
            <button
              onClick={() => setIsMobileMenuOpen(false)}
              className="cursor-pointer text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Navigation Items */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden py-6 px-3 space-y-2 custom-scrollbar">
          {MENU_ITEMS.map((item, idx) => {
            const isActive =
              item.href === pathname ||
              item.submenu?.some((sub) => sub.href === pathname);
            const isOpen = openSubmenuIndex === idx;

            return (
              <div key={idx} className="flex flex-col">
                <div
                  onClick={() => (item.submenu ? toggleSubmenu(idx) : null)}
                  className={`
                  group relative flex items-center gap-3 px-3 py-3 rounded-xl cursor-pointer transition-all duration-200
                  ${
                    isActive
                      ? "bg-[var(--accent-primary)] text-white shadow-md shadow-[var(--accent-glow)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--leaf-bg)] hover:text-[var(--text-primary)]"
                  }
                `}
                >
                  {item.submenu ? (
                    <div className="contents">
                      <item.icon size={22} className="min-w-[22px]" />
                      <span
                        className={`flex-1 font-medium whitespace-nowrap transition-all duration-300 ${
                          !isSidebarOpen && "hidden lg:w-0 lg:opacity-0"
                        }`}
                      >
                        {item.label}
                      </span>
                      {isSidebarOpen && (
                        <ChevronDown
                          size={16}
                          className={`transition-transform duration-300 ${
                            isOpen ? "rotate-180" : ""
                          }`}
                        />
                      )}
                    </div>
                  ) : (
                    <NextLink href={item.href!} className="contents">
                      <item.icon size={22} className="min-w-[22px]" />
                      <span
                        className={`flex-1 font-medium whitespace-nowrap transition-all duration-300 ${
                          !isSidebarOpen && "hidden lg:w-0 lg:opacity-0"
                        }`}
                      >
                        {item.label}
                      </span>
                    </NextLink>
                  )}

                  {/* Tooltip */}
                  {!isSidebarOpen && (
                    <div className="absolute right-14 top-1/2 -translate-y-1/2 px-2 py-1 bg-[var(--foreground)] text-[var(--background)] text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                      {item.label}
                    </div>
                  )}
                </div>

                {/* Submenu */}
                {item.submenu && isSidebarOpen && (
                  <div
                    className={`
                    overflow-hidden transition-all duration-300 ease-in-out
                    ${
                      isOpen ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0"
                    }
                  `}
                  >
                    <div className="mr-5 pr-3 border-r border-[var(--card-border)] space-y-1">
                      {item.submenu.map((sub, subIdx) => (
                        <NextLink
                          key={subIdx}
                          href={sub.href}
                          className={`
                          flex gap-2 contents px-3 py-2 rounded-lg text-sm font-medium transition-colors
                          ${
                            pathname === sub.href
                              ? "text-[var(--accent-primary)] bg-[var(--leaf-bg)]"
                              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                          }
                        `}
                        >
                          <sub.icon size={22} className="min-w-[22px]" />

                          {sub.label}
                        </NextLink>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Sidebar Footer */}
        <div className="w-full">
          <HiddenOnBiggerPhone>
            <div className="p-4 w-full border-t border-[var(--card-border)] mt-auto">
              {/* مخصوص موبایل: دکمه تغییر تم */}
              <div className="flex w-full items-center justify-between px-2 text-[var(--text-secondary)]">
                <span className="text-sm font-medium">تغییر تم</span>
                {/* 2. اضافه کردن ThemeToggle فقط در موبایل */}
                <ThemeToggle />
              </div>
            </div>
          </HiddenOnBiggerPhone>
        </div>
      </aside>

      {/* Mobile Backdrop */}
      {isMobileMenuOpen && (
        <div
          className={`fixed inset-0 bg-black/40 backdrop-blur-sm ${zindexSidebarBackdrop} lg:hidden`}
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}
    </div>
  );
}

export default Sidebar;
