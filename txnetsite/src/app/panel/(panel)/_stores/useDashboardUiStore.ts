import { create } from "zustand";

// ۱. تعریف ساختار داده‌ها (Type)
interface DashboardUIState {
  // State-ها
  isSidebarOpen: boolean;
  isMobileMenuOpen: boolean;
  openSubmenuIndex: number | null;
  isProfileOpen: boolean;
  isNotifOpen: boolean;
  isValutOpen: boolean;
  isGiftCodeModalOpen: boolean;

  // Action-ها (Functions)
  setIsSidebarOpen: (value: boolean) => void;
  setIsMobileMenuOpen: (value: boolean) => void;
  setOpenSubmenuIndex: (value: number | null) => void;
  setIsProfileOpen: (value: boolean) => void;
  setIsNotifOpen: (value: boolean) => void;
  setIsValutOpen: (value: boolean) => void;
  setIsGiftCodeModalOpen: (value: boolean) => void;
 
  // لاجیک ترکیبی
  toggleSubmenu: (idx: number) => void;
}

// ۲. ایجاد Store
export const useDashboardUIStore = create<DashboardUIState>((set) => ({
  // مقادیر اولیه (Initial Values)
  isSidebarOpen: true, // یا false، بسته به نیاز پیش‌فرض شما
  isMobileMenuOpen: false,
  openSubmenuIndex: null,
  isProfileOpen: false,
  isNotifOpen: false,
  isValutOpen: false,
  isGiftCodeModalOpen: false,

  // پیاده‌سازی Action-ها
  setIsSidebarOpen: (value) => set({ isSidebarOpen: value }),
  setIsMobileMenuOpen: (value) => set({ isMobileMenuOpen: value }),
  setOpenSubmenuIndex: (value) => set({ openSubmenuIndex: value }),
  setIsProfileOpen: (value) => set({ isProfileOpen: value }),
  setIsNotifOpen: (value) => set({ isNotifOpen: value }),
  setIsValutOpen: (value) => set({ isValutOpen: value }),
  setIsGiftCodeModalOpen: (value) => set({ isGiftCodeModalOpen: value }),

  // پیاده‌سازی لاجیک Toggle
  toggleSubmenu: (idx) =>
    set((state) => ({
      openSubmenuIndex: state.openSubmenuIndex === idx ? null : idx,
    })),
   
}));
