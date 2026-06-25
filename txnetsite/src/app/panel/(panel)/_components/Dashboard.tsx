"use client";
import React, { useState, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { usePathname } from "next/navigation";

import { useDashboardUIStore } from "../_stores/useDashboardUiStore";
import Sidebar from "./Sidebar";
import Nav from "./Nav";
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // UI state
  const { isSidebarOpen } = useDashboardUIStore(
    useShallow((s) => ({
      isSidebarOpen: s.isSidebarOpen,
    }))
  );

  // actions
  const {
    setIsMobileMenuOpen,
    setIsProfileOpen,
    setIsNotifOpen,
    setIsValutOpen,
  } = useDashboardUIStore(
    useShallow((s) => ({
      setIsMobileMenuOpen: s.setIsMobileMenuOpen,
      setIsProfileOpen: s.setIsProfileOpen,
      setIsNotifOpen: s.setIsNotifOpen,
      setIsValutOpen: s.setIsValutOpen,
    }))
  );

  // Close mobile menu on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
    setIsProfileOpen(false);
    setIsNotifOpen(false);
    setIsValutOpen(false);
  }, [pathname]);

  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-[var(--background)] font-[family-name:var(--font-body)] text-[var(--text-primary)] transition-colors duration-300"
      dir="rtl"
    >
      {/* Sidebar */}
      <Sidebar />
      {/* ================= Main Content Wrapper ================= */}
      <div
        className={`
          flex-1 flex flex-col h-full overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)]
          ${isSidebarOpen ? "lg:mr-72" : "lg:mr-20"}
        `}
      >
        {/* ================= Top Navbar ================= */}
        <Nav />
        {/* ================= Content Area ================= */}
        <main className="flex-1 overflow-y-auto p-4 ">
          <div className="w-full max-w-7xl mx-auto space-y-6">
            {/* Placeholder for Page Content */}
            <div className="glass-panel p-6 rounded-3xl min-h-[calc(100vh-160px)] shadow-sm relative">
              {children}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
