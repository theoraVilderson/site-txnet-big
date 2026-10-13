"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sun, Moon, Waves, Laptop, ChevronDown, Check } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useTheme } from "@/context/ThemeContext";
import { AVAILABLE_THEMES, type ThemeName } from "@/env";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const A = FrontendI18nKeys.common.settings.appearance;

type ThemeChoice = ThemeName | "system";

const ICONS: Record<ThemeChoice, typeof Sun> = {
  system: Laptop,
  light: Sun,
  dark: Moon,
  ocean: Waves,
};

// "system" first, then every theme env.ts offers: a new theme is one
// AVAILABLE_THEMES entry and its CSS block, its name one locale key (FE-1-a).
const OPTIONS: ThemeChoice[] = ["system", ...AVAILABLE_THEMES];

export function ThemeDropdown() {
  const { t } = useLocale();
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
        aria-label={t("common", A.theme)}
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
                  <span className="flex-1 text-start">{t("common", A.themes[opt])}</span>
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
