"use client";

import { type ChangeEvent, type ReactNode } from "react";

import { useAutofill } from "@auth/auth/_hooks/useAutofill";

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
  const { ref, autofilled, onAnimationStart } = useAutofill(value);

  const floated = autofilled || value.length > 0;

  return (
    <div className="organic-field">
      <div className="field-nature" />
      <input
        ref={ref}
        type={type}
        id={id}
        name={id}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={`organic-field-input ${dir === "ltr" ? "dir-ltr text-left font-mono" : ""}`}
        onAnimationStart={onAnimationStart}
      />
      <label htmlFor={id} className={floated ? "floated" : ""}>
        {label}
      </label>
    </div>
  );
};
