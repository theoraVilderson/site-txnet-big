"use client";

import { useRef } from "react";
import ReactDatePicker, { DateObject } from "react-multi-date-picker";
import TimePicker from "react-multi-date-picker/plugins/time_picker";
import gregorian from "react-date-object/calendars/gregorian";
import persian from "react-date-object/calendars/persian";
import gregorian_en from "react-date-object/locales/gregorian_en";
import persian_fa from "react-date-object/locales/persian_fa";
import { CalendarDays, ChevronDown, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { toEnglishDigits } from "@/util/helper";
import { LATIN_DIGITS } from "../../_lib/digits";
import "./DatePicker.css";

const D = FrontendI18nKeys.common.kit.datePicker;

/** Which calendar a language reads dates in. A language not listed reads Gregorian. */
const CALENDARS: Record<string, { calendar: typeof gregorian; locale: typeof gregorian_en }> = {
  fa: { calendar: persian, locale: persian_fa },
};
const GREGORIAN = { calendar: gregorian, locale: gregorian_en };

const ISO = "YYYY-MM-DD";
/** `withTime`: a wall time, minute precise, in the visitor's zone. */
const ISO_TIME = "YYYY-MM-DDTHH:mm";
/** Above `Dialog`'s `z-50`: the calendar is drawn on `document.body` (see `portal` below). */
const CALENDAR_Z = 60;

export interface DatePickerProps {
  label?: string;
  /**
   * A Gregorian `YYYY-MM-DD`, or null. The calendar is only how the date
   * looks: the value is the same whether the user picked it on a Jalali or a
   * Gregorian grid, so a filter never has to parse a Jalali string (legacy's
   * value was one, which is why its caller needed `parsePersianDate`).
   */
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  /**
   * Pick an hour and a minute too (GR-1-k): `value` is then a wall time
   * `YYYY-MM-DDTHH:mm` in the visitor's zone, and a day picked from empty
   * starts at 23:59 — the end of that day, as a day-only end was.
   */
  withTime?: boolean;
}

/**
 * A single-date field (F-093-b): a Jalali grid in Persian, a Gregorian one
 * otherwise, following the panel language. Day boundaries — whether a "to"
 * date includes its whole day, in whose timezone — belong to the caller.
 *
 * The calendar is drawn on `document.body` (`portal`), above any dialog, and
 * may open upward: inside a scrolling sheet it was clipped to the sheet and
 * fell below the visible part (user, 2026-10-10).
 */
export function DatePicker({ label, value, onChange, placeholder, withTime = false }: DatePickerProps) {
  const { lang, isRtl, t } = useLocale();
  const pickerRef = useRef<{ isOpen?: boolean } | null>(null);
  const { calendar, locale } = CALENDARS[lang] ?? GREGORIAN;

  const format = withTime ? ISO_TIME : ISO;
  const selected = value
    ? new DateObject({ date: value, format, calendar: gregorian, locale: gregorian_en }).convert(calendar, locale)
    : null;

  const handleChange = (date: DateObject | null) => {
    if (!date?.isValid) return onChange(null);
    const picked = new DateObject(date);
    // From empty, a day means its end — the time is then the user's to move.
    if (withTime && !value) picked.setHour(23).setMinute(59);
    // Back to Gregorian, and ASCII digits whatever the locale printed.
    onChange(toEnglishDigits(picked.convert(gregorian, gregorian_en).format(format)));
  };

  return (
    <div className="w-full">
      {label && <label className="mb-1.5 block text-xs font-medium text-text-secondary">{label}</label>}
      <ReactDatePicker
        ref={pickerRef}
        value={selected}
        onChange={handleChange}
        calendar={calendar}
        locale={locale}
        digits={LATIN_DIGITS}
        format={withTime ? "YYYY/MM/DD HH:mm" : "YYYY/MM/DD"}
        calendarPosition={isRtl ? "bottom-right" : "bottom-left"}
        editable={false}
        portal
        zIndex={CALENDAR_Z}
        plugins={withTime ? [<TimePicker key="time" position="bottom" hideSeconds />] : []}
        containerClassName="w-full"
        className="panel-date-picker"
        render={(text: string, openCalendar: () => void) => {
          const open = Boolean(pickerRef.current?.isOpen);
          return (
            <div
              role="button"
              tabIndex={0}
              onClick={openCalendar}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openCalendar()}
              className={`flex h-[50px] w-full cursor-pointer items-center justify-between rounded-xl border bg-bg-inner px-4 transition-all ${
                open ? "border-primary shadow-[0_0_0_4px_var(--accent-glow)]" : "border-card-border hover:border-text-secondary"
              }`}
            >
              <div className="flex w-full items-center gap-3 overflow-hidden">
                <span className={`rounded-lg p-1.5 ${value ? "bg-primary text-on-accent" : "bg-leaf-bg text-text-secondary"}`}>
                  <CalendarDays size={18} />
                </span>
                <span className={`truncate text-sm font-medium ${value ? "text-text-primary" : "text-text-secondary opacity-70"}`}>
                  {value ? text : placeholder ?? t("common", D.placeholder)}
                </span>
              </div>
              {value ? (
                <button
                  type="button"
                  aria-label={t("common", D.clear)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(null);
                  }}
                  className="rounded-full p-1 text-text-secondary transition-colors hover:bg-error-bg hover:text-error"
                >
                  <X size={16} />
                </button>
              ) : (
                <ChevronDown size={16} className={`text-text-secondary transition-transform ${open ? "rotate-180" : ""}`} />
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
