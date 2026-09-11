"use client";
import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import {
  UserCircle,
  Settings,
  LogOut,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import { useDashboardUIStore } from "../_stores/useDashboardUiStore";

export default function ProfileDropdown() {
  const isProfileOpen = useDashboardUIStore((s) => s.isProfileOpen);
  const setIsProfileOpen = useDashboardUIStore((s) => s.setIsProfileOpen);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // بستن منو وقتی کاربر بیرون از کادر کلیک می‌کند
  useEffect(() => {
    function handleClickOutside(event: PointerEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsProfileOpen(false);
      }
    }
    document.addEventListener("pointerdown", handleClickOutside);
    return () =>
      document.removeEventListener("pointerdown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* --- Trigger Button --- */}
      <button
        onClick={() => setIsProfileOpen(!isProfileOpen)}
        className={`
          flex items-center gap-2 sm:gap-3 md:pl-2 pl-1 pr-1 py-1 rounded-full 
          border border-[var(--card-border)] 
          transition-all duration-300 ease-out
          cursor-pointer
          ${
            isProfileOpen
              ? "bg-[var(--leaf-bg)] ring-2 ring-[var(--accent-primary)]/20"
              : "hover:bg-[var(--leaf-bg)]"
          }
        `}
      >
        {/* Avatar with Animated Gradient Ring */}
        <div className="relative w-9 h-9 sm:w-10 sm:h-10">
          <div
            className={`absolute inset-0 rounded-full bg-gradient-to-tr from-[var(--accent-primary)] to-teal-400 p-[2px] ${
              isProfileOpen ? "animate-spin-slow" : ""
            }`}
          >
            <div className="w-full h-full rounded-full bg-[var(--card-bg)] flex items-center justify-center">
              <UserCircle className="text-[var(--accent-primary)]" size={26} />
            </div>
          </div>
          {/* Online Status Dot */}
          <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white dark:border-gray-800 rounded-full shadow-sm"></span>
        </div>

        {/* Text Info */}
        <div className="hidden md:block text-right transition-opacity duration-200">
          <p className="text-sm font-bold text-[var(--text-primary)] leading-none mb-1">
            ادمین سیستم
          </p>
          <p className="text-[11px] text-[var(--text-secondary)] font-mono tracking-wider">
            09123456789
          </p>
        </div>

        {/* Rotating Chevron */}
        <ChevronDown
          size={16}
          className={` hidden md:block  text-[var(--text-secondary)] ml-1 transition-transform duration-500 cubic-bezier(0.4, 0, 0.2, 1) ${
            isProfileOpen ? "rotate-180" : "rotate-0"
          }`}
        />
      </button>

      {/* --- Dropdown Menu with "Pop & Fade" Animation --- */}
      <div
        className={`
          absolute left-0 mt-3 w-64 p-2 z-30
          glass-panel rounded-2xl shadow-xl shadow-[var(--accent-glow)]/20
          origin-top-left border border-[var(--card-border)]
          transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]
          ${
            isProfileOpen
              ? "transform scale-100 opacity-100 translate-y-0 visible"
              : "transform scale-90 opacity-0 -translate-y-2 invisible pointer-events-none"
          }
        `}
      >
        {/* Header Section */}
        <div className="px-3 py-3 mb-2 bg-[var(--leaf-bg)]/50 rounded-xl border border-[var(--card-border)]/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/50 dark:bg-black/20 rounded-lg">
              <Sparkles size={18} className="text-amber-500" />
            </div>
            <div className="overflow-hidden">
              <p className="text-sm font-bold text-[var(--text-primary)] truncate">
                حساب ویژه
              </p>
              <p className="text-[10px] text-[var(--text-secondary)]">
                وضعیت حساب کاربری : فعال
              </p>
            </div>
          </div>
        </div>

        {/* Menu Items */}
        <div className="space-y-1">
          {[
            { icon: UserCircle, label: "پروفایل من", href: "/profile" },
            { icon: Settings, label: "تنظیمات حساب", href: "/settings" },
          ].map((item, idx) => (
            <Link
              key={idx}
              href={item.href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--accent-primary)] hover:text-white hover:shadow-lg hover:shadow-[var(--accent-primary)]/30 transition-all duration-200 group"
            >
              <item.icon
                size={18}
                className="group-hover:scale-110 transition-transform"
              />
              {item.label}
            </Link>
          ))}
        </div>

        {/* Divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-[var(--card-border)] to-transparent my-2" />

        {/* Logout Button */}
        <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--error-color)] hover:bg-[var(--error-bg)] hover:scale-[1.02] active:scale-95 transition-all duration-200">
          <LogOut size={18} />
          خروج از حساب
        </button>
      </div>
    </div>
  );
}
