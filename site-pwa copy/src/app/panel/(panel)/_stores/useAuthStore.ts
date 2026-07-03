import { create } from "zustand";
import { IUserDto } from "@/types/user"; // فرض بر اینکه مدل کاربر اینجاست

interface AuthState {
  // State-ها
  user: IUserDto | null;
  isAuthenticated: boolean;
  isLoading: boolean; // برای نمایش لودینگ تا زمان دریافت اطلاعات کاربر

  // Action-ها
  setUser: (user: IUserDto) => void;
  updateUser: (data: Partial<IUserDto>) => void; // برای آپدیت جزئی (مثلا کم کردن موجودی)
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true, // پیش‌فرض true است تا وقتی چک کنیم کاربر لاگین است یا نه

  setUser: (user) =>
    set({
      user: user,
      isAuthenticated: true,
      isLoading: false,
    }),

  // مثلا وقتی کاربر VPN میخرد، فقط موجودی‌اش را آپدیت می‌کنیم نه کل یوزر را
  updateUser: (data) =>
    set((state) => ({
      user: state.user ? { ...state.user, ...data } : null,
    })),

  logout: () =>
    set({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    }),

  setLoading: (loading) => set({ isLoading: loading }),
}));
