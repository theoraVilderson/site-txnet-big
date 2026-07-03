"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // این useEffect برای جلوگیری از ارور Hydration لازم است
  // چون دکمه نباید قبل از اینکه بفهمیم تم چیست رندر شود
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null; // یا یک دکمه لودینگ نشان دهید

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="p-2  cursor-pointer rounded-full hover:bg-[var(--leaf-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      title="تغییر تم"
    >
      {theme == "dark" ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  );
}
