"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { CountryCode } from "libphonenumber-js/min";
import {
  countryOptions,
  defaultPhoneCountry,
  fromE164,
  readTyped,
  toE164,
} from "@/lib/phone";
import { useAutofill } from "@auth/auth/_hooks/useAutofill";

export interface PhoneFieldProps {
  id: string;
  label: string;
  /** The E.164 number. This is what the API is given, always. */
  value: string;
  onChange: (e164: string) => void;
  /** The panel's active language: names the countries and picks the default. */
  lang: string;
  countryLabel: string;
  searchLabel: string;
  noResultsLabel: string;
  autoComplete?: string;
  disabled?: boolean;
}

/**
 * A phone field for a platform with no single home country (ADR-0018): a
 * country selector plus a national number, exactly the shape Telegram uses,
 * submitting E.164.
 *
 * The selector opens on the country the *deployment's* language implies, not
 * the browser's — a Persian reseller's users should not have to find Iran in
 * a list of two hundred. It is still a list of two hundred, because the next
 * reseller is not Iranian.
 */
export function PhoneField({
  id,
  label,
  value,
  onChange,
  lang,
  countryLabel,
  searchLabel,
  noResultsLabel,
  autoComplete = "tel",
  disabled = false,
}: PhoneFieldProps) {
  const fallback = useMemo(() => defaultPhoneCountry(lang), [lang]);
  const parsed = useMemo(() => fromE164(value, fallback), [value, fallback]);

  const [iso, setIso] = useState<CountryCode>(parsed.iso);
  const [national, setNational] = useState(parsed.national);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const wrapper = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const {
    ref: numberBox,
    autofilled,
    onAnimationStart,
  } = useAutofill(national);

  const countries = useMemo(() => countryOptions(lang), [lang]);
  const current = countries.find((c) => c.iso === iso) ?? countries[0];

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return countries;
    return countries.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.iso.toLowerCase().includes(needle) ||
        c.dialCode.includes(needle.replace(/^\+?/, "+")),
    );
  }, [countries, query]);

  // A parent that clears the field (a reset, a step change) must clear what
  // is on screen too, or the user sees a number the form no longer holds.
  useEffect(() => {
    if (!value) setNational("");
  }, [value]);

  useEffect(() => {
    if (!open) return;
    searchBox.current?.focus();

    const onDocument = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocument);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocument);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const emit = (nextNational: string, nextIso: CountryCode) => {
    setNational(nextNational);
    setIso(nextIso);
    onChange(nextNational.trim() ? toE164(nextNational, nextIso) : "");
  };

  // Either spelling is accepted: a national number stays with the picker's
  // country, an internationally-written one moves the picker to its own.
  const onNumber = (e: ChangeEvent<HTMLInputElement>) => {
    const read = readTyped(e.target.value, iso);
    emit(read.national, read.iso);
  };

  const pick = (nextIso: CountryCode) => {
    setOpen(false);
    setQuery("");
    emit(national, nextIso);
  };

  return (
    <div className="organic-field phone-field" ref={wrapper}>
      <div className="field-nature" />
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={countryLabel}
          className="relative z-[2] flex items-center gap-1 shrink-0 rounded-xl border border-card-border bg-tab-bg px-2.5 text-sm font-mono text-text-primary transition-colors hover:text-primary"
        >
          <span aria-hidden className="text-base leading-none">
            {current?.flag}
          </span>
          <span className="dir-ltr">{current?.dialCode}</span>
          <ChevronDown size={14} aria-hidden />
        </button>

        <div className="relative flex-1">
          <input
            ref={numberBox}
            type="tel"
            inputMode="tel"
            id={id}
            name={id}
            value={national}
            onChange={onNumber}
            onAnimationStart={onAnimationStart}
            disabled={disabled}
            placeholder=" "
            autoComplete={autoComplete}
            className="organic-field-input dir-ltr text-left font-mono"
          />
          <label
            htmlFor={id}
            className={autofilled || national.length > 0 ? "floated" : ""}
          >
            {label}
          </label>
        </div>
      </div>

      {open && (
        <div
          role="listbox"
          aria-label={countryLabel}
          className="absolute z-50 mt-2 max-h-72 w-full overflow-y-auto rounded-2xl border border-card-border bg-card-bg p-2 shadow-lg"
        >
          <div className="sticky top-0 mb-1 flex items-center gap-2 rounded-xl bg-tab-bg px-2">
            <Search size={14} aria-hidden className="text-text-secondary" />
            <input
              ref={searchBox}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchLabel}
              aria-label={searchLabel}
              className="w-full bg-transparent py-2 text-sm outline-none"
            />
          </div>

          {matches.length === 0 && (
            <p className="px-2 py-3 text-sm text-text-secondary">
              {noResultsLabel}
            </p>
          )}

          {matches.map((country) => (
            <button
              key={country.iso}
              type="button"
              role="option"
              aria-selected={country.iso === iso}
              onClick={() => pick(country.iso)}
              className={`flex w-full items-center gap-2 rounded-xl px-2 py-2 text-start text-sm transition-colors ${
                country.iso === iso
                  ? "bg-tab-bg text-primary"
                  : "hover:bg-tab-bg text-text-primary"
              }`}
            >
              <span aria-hidden className="text-base leading-none">
                {country.flag}
              </span>
              <span className="flex-1 truncate">{country.name}</span>
              <span className="dir-ltr font-mono text-text-secondary">
                {country.dialCode}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
