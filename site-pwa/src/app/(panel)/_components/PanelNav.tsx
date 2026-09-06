"use client";

import { LangDropdown } from "@auth/auth/_components/LangDropdown";
import { ThemeDropdown } from "@auth/auth/_components/ThemeDropdown";
import { LogoutButton } from "./LogoutButton";
import { AccountSwitcher } from "./AccountSwitcher";

export function PanelNav() {
  return (
    <nav className="relative z-50 flex w-full items-center justify-between p-6 py-3 md:px-12">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-xl font-bold text-white shadow-lg shadow-primary-glow">
          T
        </div>
        <span className="text-2xl font-bold tracking-tight text-text-primary">
          TXNet
        </span>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <AccountSwitcher />
        <div className="mx-1 h-6 w-px bg-card-border" />
        <LangDropdown />
        <div className="mx-1 h-6 w-px bg-card-border" />
        <ThemeDropdown />
        <div className="mx-1 h-6 w-px bg-card-border" />
        <LogoutButton />
      </div>
    </nav>
  );
}
