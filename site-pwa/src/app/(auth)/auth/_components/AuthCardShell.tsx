"use client";

import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useFirstPaint } from "@auth/auth/_hooks/useFirstPaint";

function ZenLogo() {
  return (
    <div className="zen-logo block sm:hidden!">
      <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
        <circle
          cx="28"
          cy="28"
          r="26"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          opacity="0.6"
        />
        <path
          d="M28 15V25M28 32h.01"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <div className="zen-glow"></div>
    </div>
  );
}

interface AuthCardShellProps {
  animationKey: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

export function AuthCardShell({
  animationKey,
  title,
  subtitle,
  children,
}: AuthCardShellProps) {
  // روی لودِ اولِ صفحه انیمیشنِ ورود را رد کن تا فرم بلافاصله دیده شود؛
  // مانت‌های بعدی (ناوبری سمت کلاینت) دوباره انیمیشن دارند.
  const firstPaint = useFirstPaint();

  return (
    <motion.div
      key={animationKey}
      initial={
        firstPaint
          ? false
          : { opacity: 0, y: 20, filter: "blur(8px)", scale: 0.97 }
      }
      animate={{ opacity: 1, y: 0, filter: "blur(0px)", scale: 1 }}
      exit={{ opacity: 0, y: -20, filter: "blur(8px)", scale: 0.97 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="w-full"
    >
      <div className="text-center mb-2 w-full">
        <ZenLogo />
        <h1 className="text-2xl sm:text-3xl font-bold text-text-primary mb-2 tracking-tight">
          {title}
        </h1>
        <p className="text-sm text-text-secondary">{subtitle}</p>
      </div>
      {children}
    </motion.div>
  );
}

export function SuccessShell({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <motion.div
      key="success"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center w-full justify-center py-12 text-center"
    >
      <div className="zen-logo mb-4 w-full">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <circle
            cx="28"
            cy="28"
            r="26"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
            opacity="0.6"
          />
          <path
            d="M28 15V25M28 32h.01"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
        <div className="zen-glow"></div>
      </div>
      <h3 className="text-2xl font-bold text-text-primary mb-2">{title}</h3>
      <p className="text-text-secondary font-medium flex items-center gap-2 justify-center">
        <Loader2 size={16} className="animate-spin" />
        {subtitle}
      </p>
    </motion.div>
  );
}
