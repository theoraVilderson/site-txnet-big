// components/AuthInitializer.tsx
"use client";

import { useRef,useEffect } from "react";
import { useAuthStore } from "../_stores/useAuthStore"; // آدرس استور خودت
import { IUserDto } from "@/types/user";

interface Props {
  user: IUserDto | null;
  children?: React.ReactNode;
}

export default function AuthInitializer({ user, children }: Props) {
  // استفاده از useRef برای اینکه مطمئن شویم فقط یک بار اجرا می‌شود
  // (جلوگیری از اجرای دوباره در React Strict Mode)
  const initialized = useRef(false);
  const isLoading = useAuthStore((s) => s.isLoading);
  console.log("setting1");

  if (!initialized.current) {
    useAuthStore.setState({
      user: user,
      isAuthenticated: !!user,
      isLoading: false,
    });
    initialized.current = true;
  }
  // تا زمانی که لودینگ تمام نشده، چیزی رندر نکن یا اسکلتون نشان بده
  if (isLoading) return null; 

  return <>{children}</>;
}
