"use client";

import { Toaster } from "react-hot-toast";

export default function ToastProvider() {
  return (
    <Toaster
      position="bottom-left"
      reverseOrder={false}
      toastOptions={{
        // 1. تنظیمات عمومی (General)
        className: "glass-toast", // کلاس بلور که در CSS ساختیم
        duration: 4000,
        style: {
          background: "var(--card-bg)", // رنگ پس‌زمینه متغیر
          color: "var(--text-primary)", // رنگ متن اصلی
          border: "1px solid var(--card-border)",
          borderRadius: "20px", // گوشه‌های گرد مشابه اینپوت‌های شما
          padding: "12px 20px",
          boxShadow: "0 8px 30px var(--card-shadow)",
          fontSize: "14px",
          fontWeight: "500",
          direction: "rtl",
          fontFamily: "inherit",
        },

        // 2. تنظیمات موفقیت (Success)
        success: {
          iconTheme: {
            primary: "var(--accent-primary)", // سبز اصلی تم
            secondary: "var(--bg-inner)", // رنگ زمینه آیکون
          },
          style: {
            // کمی سبزتر برای حس موفقیت
            background: "var(--bg-inner)",
            border: "1px solid var(--accent-primary)",
            color: "var(--text-primary)",
          },
        },

        // 3. تنظیمات خطا (Error)
        error: {
          iconTheme: {
            primary: "var(--error-color)",
            secondary: "var(--bg-inner)",
          },
          style: {
            background: "var(--error-bg)",
            border: "1px solid var(--error-border)",
            color: "var(--error-color)", // متن قرمز/نارنجی
          },
        },

        // 4. تنظیمات لودینگ (Loading)
        loading: {
          iconTheme: {
            primary: "var(--accent-primary)",
            secondary: "var(--leaf-bg)",
          },
          style: {
            border: "1px solid var(--card-border)",
          },
        },
      }}
    />
  );
}
