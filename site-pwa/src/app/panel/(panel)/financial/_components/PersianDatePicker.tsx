// components/PersianDatePicker.tsx
"use client";

import React, { useRef } from "react";
import DatePicker, { DateObject } from "react-multi-date-picker";
import persian from "react-date-object/calendars/persian";
import persian_fa from "react-date-object/locales/persian_fa";
import { CalendarDays, X, ChevronDown } from "lucide-react";
import "./PersianDatePicker.css";
interface Props {
  label?: string;
  value: string | null;
  onChange: (date: string) => void;
  placeholder?: string;
}

export function PersianDatePicker({
  label,
  value,
  onChange,
  placeholder,
}: Props) {
  const datePickerRef = useRef<any>(null);

  // تبدیل ولیو به آبجکت تاریخ
  const dateValue = value
    ? new DateObject({
        date: value,
        format: "YYYY/MM/DD",
        calendar: persian,
        locale: persian_fa,
      })
    : null;

  const handleChange = (date: DateObject | null) => {
    if (date) {
      onChange(date.format("YYYY/MM/DD"));
    } else {
      onChange("");
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation(); // جلوگیری از باز شدن تقویم هنگام زدن ضربدر
    onChange("");
  };

  return (
    <div className="w-full group ">
      {label && (
        <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">
          {label}
        </label>
      )}

      <DatePicker
        ref={datePickerRef}
        value={dateValue}
        onChange={handleChange}
        calendar={persian}
        locale={persian_fa}
        format="YYYY/MM/DD"
        calendarPosition="bottom-center"
        editable={false}
        fixMainPosition={true}
        className="custom-calendar-popup" // اعمال کلاس‌های CSS که ساختیم
        // --- رندر سفارشی ظاهر اینپوت ---
        render={(strDate, openCalendar) => {
          const isOpen = datePickerRef.current?.isOpen; // چک کردن وضعیت باز بودن

          return (
            <div
              onClick={openCalendar}
              className={`
                relative w-full h-[50px] flex items-center justify-between px-4 rounded-xl cursor-pointer transition-all duration-300
                border bg-[var(--bg-inner)]
                ${
                  isOpen
                    ? "border-[var(--accent-primary)] shadow-[0_0_0_4px_var(--accent-glow)]"
                    : "border-[var(--card-border)] hover:border-[var(--text-secondary)]"
                }
              `}
            >
              {/* بخش سمت چپ: آیکون و متن */}
              <div className="flex items-center gap-3 w-full overflow-hidden">
                <div
                  className={`
                    p-1.5 rounded-lg transition-colors duration-300
                    ${
                      value
                        ? "bg-[var(--accent-primary)] text-white"
                        : "bg-[var(--leaf-bg)] text-[var(--text-secondary)]"
                    }
                `}
                >
                  <CalendarDays size={18} />
                </div>

                <span
                  className={`
                    text-sm font-medium truncate transition-colors duration-300
                    ${
                      value
                        ? "text-[var(--text-primary)] dir-ltr font-mono text-base"
                        : "text-[var(--text-secondary)] opacity-70"
                    }
                `}
                >
                  {value || placeholder || "انتخاب کنید"}
                </span>
              </div>

              {/* بخش سمت راست: دکمه حذف یا فلش */}
              <div className="flex items-center">
                {value ? (
                  <button
                    onClick={handleClear}
                    className="p-1 rounded-full hover:bg-[var(--error-bg)] hover:text-[var(--error-color)] text-[var(--text-secondary)] transition-colors"
                    title="حذف تاریخ"
                  >
                    <X size={16} />
                  </button>
                ) : (
                  <ChevronDown
                    size={16}
                    className={`text-[var(--text-secondary)] transition-transform duration-300 ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                )}
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
