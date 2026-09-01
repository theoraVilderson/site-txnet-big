"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Globe, ChevronDown, Check } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";

export const LangDropdown = () => {
  const { lang, setLang, availableLocales } = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const current = availableLocales.find((l) => l.code === lang);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-primary transition-colors px-3 py-2 rounded-xl hover:bg-leaf-bg"
      >
        <Globe size={20} />
        <span className="hidden sm:inline font-bold">
          {current?.shortName ?? lang.toUpperCase()}
        </span>
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
            className="absolute top-full mt-2 w-36 bg-card-bg border border-card-border rounded-xl shadow-xl shadow-card-shadow overflow-hidden z-50 end-0 backdrop-blur-xl"
          >
            {availableLocales.map((l) => (
              <button
                key={l.code}
                onClick={() => {
                  setLang(l.code);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center justify-between px-4 py-3 text-sm transition-colors ${
                  lang === l.code
                    ? "text-primary bg-leaf-bg font-bold"
                    : "text-text-secondary hover:text-primary hover:bg-leaf-bg"
                }`}
              >
                <span>{l.name}</span>
                {lang === l.code && <Check size={16} />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
