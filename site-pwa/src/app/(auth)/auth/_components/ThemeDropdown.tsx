"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sun, Moon, Waves, Laptop, ChevronDown, Check } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";
import { AVAILABLE_THEMES, type ThemeName } from "@/env";

type ThemeChoice = ThemeName | "system";

const ICONS: Record<ThemeChoice, typeof Sun> = {
  system: Laptop,
  light: Sun,
  dark: Moon,
  ocean: Waves,
};

const LABELS: Record<ThemeChoice, string> = {
  system: "پیش‌فرض سیستم",
  light: "روشن",
  dark: "تاریک",
  ocean: "اقیانوسی",
};

// "system" + همه‌ی تم‌های AVAILABLE_THEMES از env.ts — اضافه‌کردن تم بعدی
// فقط یعنی یک آیتم به AVAILABLE_THEMES + یک بلوک CSS، این لیست خودکار آپدیت می‌شه
const OPTIONS: ThemeChoice[] = ["system", ...AVAILABLE_THEMES];

export function ThemeDropdown() {
  const { theme, choice, setTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const CurrentIcon = ICONS[choice] ?? ICONS[theme];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 p-2 px-3 rounded-xl text-text-secondary hover:bg-leaf-bg hover:text-primary transition-colors"
      >
        <CurrentIcon size={20} />
        <ChevronDown
          size={14}
          className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="absolute top-full mt-2 w-44 bg-card-bg border border-card-border rounded-xl shadow-xl shadow-card-shadow overflow-hidden z-50 end-0 backdrop-blur-xl"
          >
            {OPTIONS.map((opt) => {
              const Icon = ICONS[opt];
              const active = choice === opt;
              return (
                <button
                  key={opt}
                  onClick={() => {
                    setTheme(opt);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors ${
                    active
                      ? "bg-leaf-bg text-primary font-bold"
                      : "text-text-secondary hover:bg-bg-inner hover:text-text-primary"
                  }`}
                >
                  <Icon size={16} />
                  <span className="flex-1 text-start">{LABELS[opt]}</span>
                  {active && <Check size={16} />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
