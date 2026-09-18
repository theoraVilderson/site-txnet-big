"use client";

import { BrandMark } from "@/components/BrandMark";
import { LangDropdown } from "@auth/auth/_components/LangDropdown";
import { ThemeDropdown } from "@auth/auth/_components/ThemeDropdown";

export function AuthNav() {
  return (
    <nav className="relative z-50 w-full flex items-center justify-between p-6 py-3 md:px-12">
      <div className="flex items-center gap-3">
        <BrandMark nameClassName="font-bold text-2xl tracking-tight text-text-primary" />
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <LangDropdown />
        <div className="w-px h-6 bg-card-border mx-1" />
        <ThemeDropdown />
      </div>
    </nav>
  );
}
