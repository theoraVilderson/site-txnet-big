// components/AuthInitializer.tsx
"use client";

import { useRef } from "react";
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
    // تزریق مستقیم داده به استور بدون رندر اضافی
    useAuthStore.setState({
      user: user,
      isAuthenticated: !!user, // اگر یوزر باشد true، نباشد false
      isLoading: false,
    });
    console.log("setting2");
    initialized.current = true;
  }

  return <>{!isLoading && children}</>; // این کامپوننت هیچ چیزی در UI نمایش نمی‌دهد
}
