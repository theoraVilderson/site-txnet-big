"use client";

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";

export interface OrganicFieldProps {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  placeholder?: string;
  dir?: "auto" | "ltr" | "rtl";
  autoComplete?: string;
}

export const OrganicField = ({
  id,
  label,
  type = "text",
  value,
  onChange,
  placeholder = " ",
  dir = "auto",
  autoComplete,
}: OrganicFieldProps) => {
  const [autofilled, setAutofilled] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // اگر مرورگر قبل از mount شدن کامپوننت فیلد رو autofill کرده باشه،
  // انیمیشن CSS قبل از attach شدن هندلر React اجرا شده. روی mount چک می‌کنیم.
  useEffect(() => {
    const el = inputRef.current;
    if (el && el.matches(":-webkit-autofill")) {
      setAutofilled(true);
    }
  }, []);

  const floated = autofilled || value.length > 0;

  return (
    <div className="organic-field">
      <div className="field-nature" />
      <input
        ref={inputRef}
        type={type}
        id={id}
        name={id}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={`organic-field-input ${dir === "ltr" ? "dir-ltr text-left font-mono" : ""}`}
        onAnimationStart={(e) => {
          if (e.animationName === "onAutoFillStart") setAutofilled(true);
          else if (e.animationName === "onAutoFillCancel") setAutofilled(false);
        }}
      />
      <label htmlFor={id} className={floated ? "floated" : ""}>
        {label}
      </label>
    </div>
  );
};
